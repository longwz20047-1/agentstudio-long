// backend/src/services/shareService.ts
import { Pool, PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import * as bcrypt from 'bcryptjs';
import {
  Share,
  ShareTarget,
  ShareType,
  CreateShareRequest,
  ShareItem,
} from '../types/share.js';

export class ShareService {
  constructor(private pool: Pool) {}

  /**
   * 创建分享
   */
  async createShare(
    request: CreateShareRequest
  ): Promise<{ shareId: string; shareLinkToken?: string }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const shareId = uuidv4();
      let shareLinkToken: string | undefined;
      let linkPasswordHash: string | undefined;

      // 防重复分享：公开分享同一资源只允许一个有效的（按 share_mode 维度查重）
      if (request.shareMode === 'public') {
        const existing = await this.checkShareExists(
          request.shareType, request.targetId, request.userId, 'public'
        );
        if (existing.shared) {
          await client.query('ROLLBACK');
          return { shareId: existing.shareId! };
        }
      }

      // 生成链接 token
      if (request.shareMode === 'link') {
        shareLinkToken = uuidv4().replace(/-/g, '');
      }

      // 哈希密码（参考: bcryptjs 已在项目中使用，见 backend/package.json）
      if (request.linkPassword) {
        linkPasswordHash = await bcrypt.hash(request.linkPassword, 10);
      }

      // 获取目标名称和所属知识库ID
      const { targetName, targetKbId } = await this.getTargetInfo(
        request.shareType,
        request.targetId
      );

      // 插入分享记录
      await client.query(
        `INSERT INTO shares (
          id, share_type, target_id, target_name, target_kb_id,
          share_mode, share_link_token, link_password,
          permissions, status,
          owner_tenant_id, owner_user_id, owner_username,
          expires_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW())`,
        [
          shareId,
          request.shareType,
          request.targetId,
          targetName,
          targetKbId,
          request.shareMode,
          shareLinkToken,
          linkPasswordHash,
          request.permissions || 'read',
          'active',
          request.tenantId,
          request.userId,
          request.username,
          request.expiresAt || null,
        ]
      );

      // 添加目标用户
      if (request.shareMode === 'user' && request.targetUsers) {
        for (const user of request.targetUsers) {
          if (user.userId) {
            await this.addShareTargetInternal(client, shareId, user.userId);
          } else if (user.email) {
            const foundUser = await this.findUserByEmail(user.email);
            if (foundUser) {
              await this.addShareTargetInternal(client, shareId, foundUser.id);
            }
          }
        }
      }

      await client.query('COMMIT');
      return { shareId, shareLinkToken };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 获取分享详情
   */
  async getShareById(shareId: string): Promise<Share | null> {
    const result = await this.pool.query(
      `SELECT * FROM shares WHERE id = $1 AND deleted_at IS NULL`,
      [shareId]
    );
    return result.rows[0] || null;
  }

  /**
   * 通过 token 获取分享
   */
  async getShareByToken(token: string): Promise<Share | null> {
    const result = await this.pool.query(
      `SELECT * FROM shares WHERE share_link_token = $1 AND deleted_at IS NULL`,
      [token]
    );
    return result.rows[0] || null;
  }

  /**
   * 验证链接密码
   * 无密码保护的分享直接返回 true（放行）
   */
  async verifyLinkPassword(token: string, password: string): Promise<boolean> {
    const share = await this.getShareByToken(token);
    if (!share) {
      return false;
    }
    // 无密码保护，直接放行
    if (!share.link_password) {
      return true;
    }
    return bcrypt.compare(password, share.link_password);
  }

  /**
   * 获取我创建的分享
   */
  async getMyShares(
    userId: string,
    page = 1,
    pageSize = 20,
    shareType?: ShareType
  ): Promise<{ items: ShareItem[]; total: number }> {
    const offset = (page - 1) * pageSize;
    let whereClause = 's.owner_user_id = $1 AND s.deleted_at IS NULL';
    const params: any[] = [userId];

    if (shareType) {
      whereClause += ' AND s.share_type = $2';
      params.push(shareType);
    }

    const countResult = await this.pool.query(
      `SELECT COUNT(*) FROM shares s WHERE ${whereClause}`,
      params
    );

    const result = await this.pool.query(
      `SELECT s.*, kb.name AS target_kb_name,
              COALESCE(NULLIF(s.target_name, ''), k.file_name, k.title, k.source) AS resolved_target_name
       FROM shares s
       LEFT JOIN knowledge_bases kb ON s.target_kb_id = kb.id
       LEFT JOIN knowledges k ON s.share_type = 'knowledge' AND k.id::text = s.target_id
       WHERE ${whereClause}
       ORDER BY s.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset]
    );

    return {
      items: result.rows.map((row: any) => this.mapToShareItem(row)),
      total: parseInt(countResult.rows[0].count),
    };
  }

  /**
   * 获取分享给我的
   */
  async getSharedToMe(
    userId: string,
    page = 1,
    pageSize = 20,
    shareType?: ShareType
  ): Promise<{ items: ShareItem[]; total: number }> {
    const offset = (page - 1) * pageSize;

    let whereClause = 'st.target_user_id = $1 AND s.deleted_at IS NULL AND s.status = \'active\'';
    const countParams: any[] = [userId];
    const queryParams: any[] = [userId];

    if (shareType) {
      countParams.push(shareType);
      queryParams.push(shareType);
      whereClause += ` AND s.share_type = $${countParams.length}`;
    }

    const countResult = await this.pool.query(
      `SELECT COUNT(*) FROM share_targets st
       JOIN shares s ON st.share_id = s.id
       WHERE ${whereClause}`,
      countParams
    );

    queryParams.push(pageSize, offset);
    const result = await this.pool.query(
      `SELECT s.*, kb.name AS target_kb_name,
              COALESCE(NULLIF(s.target_name, ''), k.file_name, k.title, k.source) AS resolved_target_name
       FROM share_targets st
       JOIN shares s ON st.share_id = s.id
       LEFT JOIN knowledge_bases kb ON s.target_kb_id = kb.id
       LEFT JOIN knowledges k ON s.share_type = 'knowledge' AND k.id::text = s.target_id
       WHERE ${whereClause}
       ORDER BY s.created_at DESC LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`,
      queryParams
    );

    return {
      items: result.rows.map((row: any) => this.mapToShareItem(row)),
      total: parseInt(countResult.rows[0].count),
    };
  }

  /**
   * 获取公开的分享
   */
  async getPublicShares(
    page = 1,
    pageSize = 20,
    shareType?: ShareType
  ): Promise<{ items: ShareItem[]; total: number }> {
    const offset = (page - 1) * pageSize;

    let whereClause = 's.share_mode = \'public\' AND s.deleted_at IS NULL AND s.status = \'active\'';
    const countParams: any[] = [];
    const queryParams: any[] = [];

    if (shareType) {
      countParams.push(shareType);
      queryParams.push(shareType);
      whereClause += ` AND s.share_type = $${countParams.length}`;
    }

    const countResult = await this.pool.query(
      `SELECT COUNT(*) FROM shares s
       WHERE ${whereClause}`,
      countParams
    );

    queryParams.push(pageSize, offset);
    const result = await this.pool.query(
      `SELECT s.*, kb.name AS target_kb_name,
              COALESCE(NULLIF(s.target_name, ''), k.file_name, k.title, k.source) AS resolved_target_name
       FROM shares s
       LEFT JOIN knowledge_bases kb ON s.target_kb_id = kb.id
       LEFT JOIN knowledges k ON s.share_type = 'knowledge' AND k.id::text = s.target_id
       WHERE ${whereClause}
       ORDER BY s.created_at DESC LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`,
      queryParams
    );

    return {
      items: result.rows.map((row: any) => this.mapToShareItem(row)),
      total: parseInt(countResult.rows[0].count),
    };
  }

  /**
   * 更新分享
   * 注意：模式切换时会自动清理关联数据（share_targets / link token）
   */
  async updateShare(
    shareId: string,
    updates: {
      status?: string;
      expiresAt?: string;
      shareMode?: string;
      linkPassword?: string;
    }
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const setClauses: string[] = ['updated_at = NOW()'];
      const params: any[] = [];
      let paramIndex = 1;

      if (updates.status) {
        setClauses.push(`status = $${paramIndex++}`);
        params.push(updates.status);
      }
      if (updates.expiresAt !== undefined) {
        setClauses.push(`expires_at = $${paramIndex++}`);
        params.push(updates.expiresAt || null);
      }
      if (updates.shareMode) {
        setClauses.push(`share_mode = $${paramIndex++}`);
        params.push(updates.shareMode);
        // 切换到 link 模式时自动生成 token
        if (updates.shareMode === 'link') {
          setClauses.push(`share_link_token = $${paramIndex++}`);
          params.push(uuidv4().replace(/-/g, ''));
        }
        // 切换离开 link 模式时清除 token 和密码
        if (updates.shareMode !== 'link') {
          setClauses.push(`share_link_token = NULL`);
          setClauses.push(`link_password = NULL`);
        }
      }
      if (updates.linkPassword !== undefined) {
        if (updates.linkPassword) {
          const hash = await bcrypt.hash(updates.linkPassword, 10);
          setClauses.push(`link_password = $${paramIndex++}`);
          params.push(hash);
        } else {
          setClauses.push(`link_password = NULL`);
        }
      }

      params.push(shareId);

      await client.query(
        `UPDATE shares SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`,
        params
      );

      // 模式切换副作用：切换离开 user 模式时清理目标用户
      if (updates.shareMode && updates.shareMode !== 'user') {
        await client.query(
          `DELETE FROM share_targets WHERE share_id = $1`,
          [shareId]
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 删除分享（软删除）
   */
  async deleteShare(shareId: string): Promise<void> {
    await this.pool.query(
      `UPDATE shares SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [shareId]
    );
  }

  /**
   * 增加访问计数
   */
  async incrementViewCount(shareId: string): Promise<void> {
    await this.pool.query(
      `UPDATE shares SET view_count = view_count + 1, last_accessed_at = NOW() WHERE id = $1`,
      [shareId]
    );
  }

  // ========== 分享目标用户管理 ==========

  async getShareTargets(shareId: string): Promise<ShareTarget[]> {
    const result = await this.pool.query(
      `SELECT * FROM share_targets WHERE share_id = $1 ORDER BY created_at`,
      [shareId]
    );
    return result.rows;
  }

  async addShareTarget(shareId: string, userId: string): Promise<ShareTarget | null> {
    const user = await this.findUserById(userId);
    if (!user) return null;

    const id = uuidv4();
    await this.pool.query(
      `INSERT INTO share_targets (id, share_id, target_user_id, target_username, target_email, target_tenant_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (share_id, target_user_id) DO NOTHING`,
      [id, shareId, userId, user.username, user.email, user.tenant_id]
    );

    return {
      id,
      share_id: shareId,
      target_user_id: userId,
      target_username: user.username,
      target_email: user.email,
      target_tenant_id: user.tenant_id,
      created_at: new Date(),
    };
  }

  async removeShareTarget(shareId: string, userId: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM share_targets WHERE share_id = $1 AND target_user_id = $2`,
      [shareId, userId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async checkShareExists(
    shareType: ShareType,
    targetId: string,
    ownerUserId: string,
    shareMode?: string
  ): Promise<{ shared: boolean; shareId?: string }> {
    let query = `SELECT id FROM shares
       WHERE share_type = $1 AND target_id = $2 AND owner_user_id = $3
         AND deleted_at IS NULL AND status = 'active'`;
    const params: any[] = [shareType, targetId, ownerUserId];

    if (shareMode) {
      query += ' AND share_mode = $4';
      params.push(shareMode);
    }

    query += ' LIMIT 1';

    const result = await this.pool.query(query, params);

    if (result.rows.length > 0) {
      return { shared: true, shareId: result.rows[0].id };
    }
    return { shared: false };
  }

  async logAccess(
    shareId: string,
    accessType: 'view' | 'download' | 'copy',
    accessorUserId?: string,
    accessorIp?: string
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO share_access_logs (id, share_id, accessor_user_id, accessor_ip, access_type, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [uuidv4(), shareId, accessorUserId, accessorIp, accessType]
    );
  }

  /**
   * 通过邮箱查找用户（公开方法，供路由层使用）
   */
  async findUserByEmail(email: string) {
    const result = await this.pool.query(
      `SELECT id, username, email, tenant_id FROM users WHERE email = $1`,
      [email]
    );
    return result.rows[0] || null;
  }

  // ========== Private helpers ==========

  private async addShareTargetInternal(
    client: PoolClient,
    shareId: string,
    userId: string
  ): Promise<void> {
    const user = await this.findUserById(userId);
    await client.query(
      `INSERT INTO share_targets (id, share_id, target_user_id, target_username, target_email, target_tenant_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (share_id, target_user_id) DO NOTHING`,
      [uuidv4(), shareId, userId, user?.username, user?.email, user?.tenant_id]
    );
  }

  private async getTargetInfo(
    shareType: ShareType,
    targetId: string
  ): Promise<{ targetName: string; targetKbId?: string }> {
    if (shareType === 'knowledge_base') {
      const result = await this.pool.query(
        `SELECT name FROM knowledge_bases WHERE id = $1`,
        [targetId]
      );
      return { targetName: result.rows[0]?.name || '' };
    } else {
      const result = await this.pool.query(
        `SELECT title, file_name, source, knowledge_base_id FROM knowledges WHERE id = $1`,
        [targetId]
      );
      const row = result.rows[0];
      return {
        targetName: row?.file_name || row?.title || row?.source || '',
        targetKbId: row?.knowledge_base_id,
      };
    }
  }

  private async findUserById(userId: string) {
    const result = await this.pool.query(
      `SELECT id, username, email, tenant_id FROM users WHERE id = $1`,
      [userId]
    );
    return result.rows[0] || null;
  }

  private mapToShareItem(row: any): ShareItem {
    return {
      shareId: row.id,
      shareType: row.share_type,
      targetId: row.target_id,
      targetName: row.resolved_target_name || row.target_name || '',
      targetKbId: row.target_kb_id,
      targetKbName: row.target_kb_name || undefined,
      shareMode: row.share_mode,
      permissions: row.permissions,
      status: row.expires_at && new Date(row.expires_at) < new Date() ? 'expired' : row.status,
      ownerUserId: row.owner_user_id,
      ownerUsername: row.owner_username || '',
      viewCount: row.view_count || 0,
      createdAt: row.created_at?.toISOString(),
      expiresAt: row.expires_at?.toISOString(),
    };
  }
}
