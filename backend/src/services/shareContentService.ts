// backend/src/services/shareContentService.ts
import { Pool } from 'pg';
import path from 'path';
import { ShareService } from './shareService.js';
import { TagService } from './tagService.js';

/**
 * 将 MinIO 存储路径转换为 HTTP URL
 * 例如: "minio:\weknora-files\10001\abc\file.png" → "http://host:9000/weknora-files/10001/abc/file.png"
 */
function minioPathToUrl(filePath: string): string {
  const minioEndpoint = process.env.WEKNORA_MINIO_ENDPOINT || 'http://192.168.100.30:9000';
  // 去掉 "minio:" 或 "minio\" 前缀，统一斜杠
  const objectPath = filePath.replace(/^minio[:\\/]+/, '').replace(/\\/g, '/');
  return `${minioEndpoint}/${objectPath}`;
}

export class ShareContentService {
  constructor(
    private pool: Pool,
    private shareService: ShareService
  ) {}

  /**
   * 获取分享的知识库详情
   */
  async getKnowledgeBase(shareId: string) {
    const share = await this.shareService.getShareById(shareId);
    if (!share) throw new Error('SHARE_NOT_FOUND');

    // 确定知识库 ID：知识库分享直接用 target_id，文档分享用 target_kb_id
    const kbId = share.share_type === 'knowledge_base'
      ? share.target_id
      : share.target_kb_id;

    if (!kbId) throw new Error('KB_NOT_FOUND');

    const result = await this.pool.query(
      `SELECT id, name, type, description, created_at, updated_at
       FROM knowledge_bases WHERE id = $1 AND deleted_at IS NULL`,
      [kbId]
    );

    if (result.rows.length === 0) throw new Error('KB_NOT_FOUND');

    const kb = result.rows[0];

    // 获取文档计数
    const countResult = await this.pool.query(
      `SELECT COUNT(*) FROM knowledges WHERE knowledge_base_id = $1 AND deleted_at IS NULL`,
      [kbId]
    );

    return {
      id: kb.id,
      name: kb.name,
      type: kb.type,
      description: kb.description,
      documentCount: parseInt(countResult.rows[0].count),
      createdAt: kb.created_at?.toISOString(),
      updatedAt: kb.updated_at?.toISOString(),
    };
  }

  /**
   * 获取知识库的文档列表
   */
  async getKnowledgeBaseDocuments(shareId: string, page = 1, pageSize = 20) {
    const share = await this.shareService.getShareById(shareId);
    if (!share) throw new Error('SHARE_NOT_FOUND');

    const kbId = share.share_type === 'knowledge_base'
      ? share.target_id
      : share.target_kb_id;

    if (!kbId) throw new Error('KB_NOT_FOUND');

    const offset = (page - 1) * pageSize;

    const countResult = await this.pool.query(
      `SELECT COUNT(*) FROM knowledges WHERE knowledge_base_id = $1 AND deleted_at IS NULL`,
      [kbId]
    );

    const result = await this.pool.query(
      `SELECT id, title, description, file_name, file_type, file_size, parse_status, source, type, tag_id, created_at, updated_at
       FROM knowledges
       WHERE knowledge_base_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [kbId, pageSize, offset]
    );

    return {
      items: result.rows.map((row: any) => ({
        id: row.id,
        name: row.file_name || row.title || row.source || '未命名文档',
        file_name: row.file_name || row.title || row.source || '',
        file_type: row.file_type || (row.type === 'url' ? 'URL' : row.type === 'manual' ? 'MANUAL' : ''),
        file_size: row.file_size,
        parse_status: row.parse_status,
        description: row.description,
        source: row.source,
        type: row.type,
        tag_id: row.tag_id,
        created_at: row.created_at?.toISOString(),
        updated_at: row.updated_at?.toISOString(),
      })),
      total: parseInt(countResult.rows[0].count),
      page,
      pageSize,
    };
  }

  /**
   * 获取分享的文档详情
   * @param docId 可选，知识库分享模式下指定文档ID
   */
  async getDocument(shareId: string, docId?: string) {
    const share = await this.shareService.getShareById(shareId);
    if (!share) throw new Error('SHARE_NOT_FOUND');

    let targetDocId: string | null;

    if (share.share_type === 'knowledge') {
      // 文档分享：直接用 target_id
      targetDocId = share.target_id;
    } else if (share.share_type === 'knowledge_base' && docId) {
      // 知识库分享 + 指定文档ID：验证文档属于该知识库
      const check = await this.pool.query(
        `SELECT id FROM knowledges WHERE id = $1 AND knowledge_base_id = $2 AND deleted_at IS NULL`,
        [docId, share.target_id]
      );
      if (check.rows.length === 0) throw new Error('DOC_NOT_FOUND');
      targetDocId = docId;
    } else {
      throw new Error('DOC_NOT_FOUND');
    }

    const result = await this.pool.query(
      `SELECT k.id, k.title, k.description, k.file_name, k.file_type, k.file_size,
              k.knowledge_base_id, k.source, k.type, k.created_at, k.updated_at,
              kb.name as kb_name
       FROM knowledges k
       LEFT JOIN knowledge_bases kb ON k.knowledge_base_id = kb.id
       WHERE k.id = $1 AND k.deleted_at IS NULL`,
      [targetDocId]
    );

    if (result.rows.length === 0) throw new Error('DOC_NOT_FOUND');

    const doc = result.rows[0];
    return {
      id: doc.id,
      name: doc.file_name || doc.title || doc.source || '未命名文档',
      title: doc.title,
      description: doc.description,
      file_name: doc.file_name || doc.title || doc.source || '',
      file_type: doc.file_type || (doc.type === 'url' ? 'URL' : doc.type === 'manual' ? 'MANUAL' : ''),
      file_size: doc.file_size,
      source: doc.source,
      type: doc.type,
      knowledge_base_id: doc.knowledge_base_id,
      kb_name: doc.kb_name,
      created_at: doc.created_at?.toISOString(),
      updated_at: doc.updated_at?.toISOString(),
    };
  }

  /**
   * 获取文档分块内容
   * @param docId 可选，知识库分享模式下指定文档ID
   */
  async getDocumentChunks(shareId: string, page = 1, pageSize = 25, docId?: string) {
    const share = await this.shareService.getShareById(shareId);
    if (!share) throw new Error('SHARE_NOT_FOUND');

    let targetDocId: string | null;

    if (share.share_type === 'knowledge') {
      targetDocId = share.target_id;
    } else if (share.share_type === 'knowledge_base' && docId) {
      // 验证文档属于该知识库
      const check = await this.pool.query(
        `SELECT id FROM knowledges WHERE id = $1 AND knowledge_base_id = $2 AND deleted_at IS NULL`,
        [docId, share.target_id]
      );
      if (check.rows.length === 0) throw new Error('DOC_NOT_FOUND');
      targetDocId = docId;
    } else {
      throw new Error('DOC_NOT_FOUND');
    }

    const offset = (page - 1) * pageSize;

    const countResult = await this.pool.query(
      `SELECT COUNT(*) FROM chunks WHERE knowledge_id = $1 AND deleted_at IS NULL`,
      [targetDocId]
    );

    const result = await this.pool.query(
      `SELECT id, content, chunk_index, chunk_type, metadata, start_at, end_at
       FROM chunks
       WHERE knowledge_id = $1 AND deleted_at IS NULL
       ORDER BY chunk_index
       LIMIT $2 OFFSET $3`,
      [targetDocId, pageSize, offset]
    );

    return {
      items: result.rows.map((row: any) => ({
        id: row.id,
        content: row.content,
        chunk_index: row.chunk_index,
        chunk_type: row.chunk_type,
        metadata: row.metadata,
        start_at: row.start_at,
        end_at: row.end_at,
      })),
      total: parseInt(countResult.rows[0].count),
      page,
      pageSize,
    };
  }

  /**
   * 获取文档下载信息
   * @param docId 可选，知识库分享模式下指定文档ID
   */
  async getDownloadInfo(shareId: string, docId?: string) {
    const share = await this.shareService.getShareById(shareId);
    if (!share) throw new Error('SHARE_NOT_FOUND');

    let targetDocId: string | null;

    if (share.share_type === 'knowledge') {
      targetDocId = share.target_id;
    } else if (share.share_type === 'knowledge_base' && docId) {
      const check = await this.pool.query(
        `SELECT id FROM knowledges WHERE id = $1 AND knowledge_base_id = $2 AND deleted_at IS NULL`,
        [docId, share.target_id]
      );
      if (check.rows.length === 0) throw new Error('DOC_NOT_FOUND');
      targetDocId = docId;
    } else {
      throw new Error('DOC_NOT_FOUND');
    }

    const result = await this.pool.query(
      `SELECT file_name, file_type, file_size, file_path
       FROM knowledges WHERE id = $1 AND deleted_at IS NULL`,
      [targetDocId]
    );

    if (result.rows.length === 0) throw new Error('DOC_NOT_FOUND');

    const doc = result.rows[0];
    if (!doc.file_path) throw new Error('FILE_NOT_FOUND');

    // 判断是否为 MinIO 存储路径（格式: minio:\bucket\path 或 minio:/bucket/path）
    const isMinioPath = /^minio[:\\/]/.test(doc.file_path);

    if (!isMinioPath) {
      // 本地文件路径安全校验
      const allowedBase = process.env.WEKNORA_FILES_DIR;
      if (allowedBase) {
        const resolved = path.resolve(doc.file_path);
        if (!resolved.startsWith(path.resolve(allowedBase))) {
          throw new Error('FILE_NOT_FOUND');
        }
      }
    }

    return {
      fileName: doc.file_name,
      fileType: doc.file_type,
      fileSize: doc.file_size,
      filePath: doc.file_path,
      isMinioPath,
    };
  }

  /**
   * 获取知识库的文档分类标签列表（只读）
   */
  async getKnowledgeBaseTags(shareId: string) {
    const share = await this.shareService.getShareById(shareId);
    if (!share) throw new Error('SHARE_NOT_FOUND');

    const kbId = share.share_type === 'knowledge_base'
      ? share.target_id
      : share.target_kb_id;

    if (!kbId) throw new Error('KB_NOT_FOUND');

    // 查询标签列表，并统计每个标签下的文档数
    const result = await this.pool.query(
      `SELECT t.id, t.name, t.color, t.sort_order,
              COUNT(k.id) AS knowledge_count
       FROM knowledge_tags t
       LEFT JOIN knowledges k ON k.tag_id = t.id AND k.deleted_at IS NULL
       WHERE t.knowledge_base_id = $1 AND t.deleted_at IS NULL
       GROUP BY t.id, t.name, t.color, t.sort_order
       ORDER BY t.sort_order ASC, t.created_at DESC`,
      [kbId]
    );

    return {
      items: result.rows.map((row: any) => ({
        id: row.id,
        name: row.name,
        color: row.color,
        sort_order: row.sort_order,
        knowledge_count: parseInt(row.knowledge_count) || 0,
      })),
    };
  }

  /**
   * 获取知识库的树形文档分类标签（只读）
   */
  async getTagTree(shareId: string) {
    const share = await this.shareService.getShareById(shareId);
    if (!share) throw new Error('SHARE_NOT_FOUND');

    const kbId = share.share_type === 'knowledge_base'
      ? share.target_id
      : share.target_kb_id;

    if (!kbId) throw new Error('KB_NOT_FOUND');

    const tagService = new TagService(this.pool);
    const [tags, counts] = await Promise.all([
      tagService.getTagsByKbId(kbId),
      tagService.getDocumentCounts(kbId),
    ]);
    const tree = TagService.buildTagTree(tags);

    return { items: tree, total: tags.length, total_count: counts.total_count, untagged_count: counts.untagged_count };
  }

  /**
   * 在分享内容中搜索（全文匹配 chunks）
   * - 知识库分享：搜索该知识库下所有文档的 chunks
   * - 文档分享：搜索该文档的 chunks
   */
  async searchContent(
    shareId: string,
    keyword: string,
    page = 1,
    pageSize = 20
  ) {
    const share = await this.shareService.getShareById(shareId);
    if (!share) throw new Error('SHARE_NOT_FOUND');

    const offset = (page - 1) * pageSize;
    let countQuery: string;
    let dataQuery: string;
    let params: any[];

    if (share.share_type === 'knowledge_base') {
      // 知识库分享：搜索该 KB 下所有文档的 chunks
      // 转义 ILIKE 特殊字符（%, _, \）防止用户输入干扰查询
      const escapedKeyword = keyword.replace(/[%_\\]/g, '\\$&');
      const likePattern = `%${escapedKeyword}%`;

      countQuery = `
        SELECT COUNT(*) FROM chunks c
        JOIN knowledges k ON c.knowledge_id = k.id
        WHERE k.knowledge_base_id = $1
          AND c.deleted_at IS NULL AND k.deleted_at IS NULL
          AND c.content ILIKE $2
      `;
      dataQuery = `
        SELECT c.id, c.content, c.chunk_index,
               k.id AS document_id, k.title AS document_title
        FROM chunks c
        JOIN knowledges k ON c.knowledge_id = k.id
        WHERE k.knowledge_base_id = $1
          AND c.deleted_at IS NULL AND k.deleted_at IS NULL
          AND c.content ILIKE $2
        ORDER BY k.title, c.chunk_index
        LIMIT $3 OFFSET $4
      `;
      params = [share.target_id, likePattern, pageSize, offset];
    } else {
      // 文档分享：搜索该文档的 chunks
      const escapedKeyword = keyword.replace(/[%_\\]/g, '\\$&');
      const likePattern = `%${escapedKeyword}%`;

      countQuery = `
        SELECT COUNT(*) FROM chunks c
        JOIN knowledges k ON c.knowledge_id = k.id
        WHERE c.knowledge_id = $1
          AND c.deleted_at IS NULL
          AND c.content ILIKE $2
      `;
      dataQuery = `
        SELECT c.id, c.content, c.chunk_index,
               k.id AS document_id, k.title AS document_title
        FROM chunks c
        JOIN knowledges k ON c.knowledge_id = k.id
        WHERE c.knowledge_id = $1
          AND c.deleted_at IS NULL
          AND c.content ILIKE $2
        ORDER BY c.chunk_index
        LIMIT $3 OFFSET $4
      `;
      params = [share.target_id, likePattern, pageSize, offset];
    }

    const countResult = await this.pool.query(
      countQuery,
      [params[0], params[1]]
    );

    const result = await this.pool.query(dataQuery, params);

    return {
      items: result.rows.map((row: any) => {
        // 生成包含关键词的摘要片段（前后各取 80 字符）
        const content: string = row.content || '';
        const idx = content.toLowerCase().indexOf(keyword.toLowerCase());
        const start = Math.max(0, idx - 80);
        const end = Math.min(content.length, idx + keyword.length + 80);
        const highlight = (start > 0 ? '...' : '')
          + content.slice(start, end)
          + (end < content.length ? '...' : '');

        return {
          chunkId: row.id,
          content: row.content,
          chunkIndex: row.chunk_index,
          documentId: row.document_id,
          documentTitle: row.document_title,
          highlight,
        };
      }),
      total: parseInt(countResult.rows[0].count),
      page,
      pageSize,
      keyword,
    };
  }
}
