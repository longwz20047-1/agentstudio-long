// backend/src/services/weknoraUserService.ts
import dotenv from 'dotenv';
import pg, { Pool } from 'pg';
import { WeKnoraUser } from '../types/users';

// 确保环境变量在服务初始化前加载
dotenv.config();

// 修复 TIMESTAMP WITHOUT TIME ZONE 的时区解释问题
// pg 驱动默认用本地时区解释无时区时间戳，当 DB 服务器与应用服务器时区不同时会导致偏差
// 统一将无时区时间戳解释为 UTC
const TIMESTAMP_OID = 1114;
pg.types.setTypeParser(TIMESTAMP_OID, (val: string) => {
  return val === null ? null : new Date(val + '+00');
});

export class WeKnoraUserService {
  private pool: Pool | null = null;
  private cache: WeKnoraUser[] | null = null;
  private cacheTime: number = 0;
  private cacheTTL: number = 5 * 60 * 1000; // 5 minutes
  private _isAvailable: boolean = false;

  constructor() {
    // 检查是否配置了数据库连接
    this._isAvailable = !!process.env.WEKNORA_DB_HOST;
    if (!this._isAvailable) {
      console.log('[WeKnoraUserService] WEKNORA_DB_HOST not configured, user management disabled');
    }
  }

  /**
   * 检查服务是否可用
   */
  get isAvailable(): boolean {
    return this._isAvailable;
  }

  private getPool(): Pool | null {
    if (!this._isAvailable) {
      return null;
    }

    if (!this.pool) {
      this.pool = new Pool({
        host: process.env.WEKNORA_DB_HOST,
        port: parseInt(process.env.WEKNORA_DB_PORT || '5432'),
        database: process.env.WEKNORA_DB_NAME || 'WeKnora',
        user: process.env.WEKNORA_DB_USER || 'postgres',
        password: process.env.WEKNORA_DB_PASSWORD || '',
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });
    }
    return this.pool;
  }

  async listUsers(): Promise<WeKnoraUser[]> {
    // 服务不可用时返回空数组
    if (!this._isAvailable) {
      return [];
    }

    // 检查缓存
    if (this.cache && Date.now() - this.cacheTime < this.cacheTTL) {
      return this.cache;
    }

    try {
      const pool = this.getPool();
      if (!pool) {
        return [];
      }

      const result = await pool.query(`
        SELECT id, username, email, avatar, tenant_id, is_active
        FROM users
        WHERE deleted_at IS NULL AND is_active = true
        ORDER BY username
      `);

      this.cache = result.rows;
      this.cacheTime = Date.now();
      return this.cache;
    } catch (error) {
      console.error('[WeKnoraUserService] Failed to fetch users:', error);
      // 返回过期缓存或空数组，不影响主功能
      return this.cache || [];
    }
  }

  async getUserById(id: string): Promise<WeKnoraUser | null> {
    const users = await this.listUsers();
    return users.find(u => u.id === id) || null;
  }

  /**
   * 测试数据库连接
   */
  async testConnection(): Promise<{ success: boolean; error?: string }> {
    if (!this._isAvailable) {
      return { success: false, error: 'WEKNORA_DB_HOST not configured' };
    }

    try {
      const pool = this.getPool();
      if (!pool) {
        return { success: false, error: 'Failed to create connection pool' };
      }
      await pool.query('SELECT 1');
      return { success: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: message };
    }
  }

  clearCache(): void {
    this.cache = null;
    this.cacheTime = 0;
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  /**
   * 获取数据库连接池（供其他服务复用）
   */
  getDbPool(): Pool | null {
    return this.getPool();
  }

  /**
   * 搜索用户（按用户名或邮箱模糊匹配）
   */
  async searchUsers(keyword: string, tenantId?: number, limit = 20): Promise<WeKnoraUser[]> {
    if (!this._isAvailable) {
      return [];
    }

    try {
      const pool = this.getPool();
      if (!pool) return [];

      let query = `
        SELECT id, username, email, avatar, tenant_id, is_active
        FROM users
        WHERE deleted_at IS NULL AND is_active = true
          AND (LOWER(username) LIKE LOWER($1) OR LOWER(email) LIKE LOWER($1))
      `;
      const params: any[] = [`%${keyword.replace(/[%_\\]/g, '\\$&')}%`];

      if (tenantId) {
        query += ' AND tenant_id = $2';
        params.push(tenantId);
      }

      query += ` ORDER BY username LIMIT $${params.length + 1}`;
      params.push(limit);

      const result = await pool.query(query, params);
      return result.rows;
    } catch (error) {
      console.error('[WeKnoraUserService] Failed to search users:', error);
      return [];
    }
  }

  /**
   * 获取指定租户的用户列表
   */
  async getTenantUsers(tenantId: number, page = 1, pageSize = 200): Promise<{ items: WeKnoraUser[]; total: number }> {
    if (!this._isAvailable) {
      return { items: [], total: 0 };
    }

    try {
      const pool = this.getPool();
      if (!pool) return { items: [], total: 0 };

      const offset = (page - 1) * pageSize;

      let countQuery = 'SELECT COUNT(*) FROM users WHERE is_active = true AND deleted_at IS NULL';
      let selectQuery = `SELECT id, username, email, avatar, tenant_id, is_active
         FROM users
         WHERE is_active = true AND deleted_at IS NULL`;
      const countParams: any[] = [];
      const selectParams: any[] = [];

      if (tenantId > 0) {
        countQuery += ' AND tenant_id = $1';
        selectQuery += ' AND tenant_id = $1';
        countParams.push(tenantId);
        selectParams.push(tenantId);
      }

      selectQuery += ` ORDER BY username LIMIT $${selectParams.length + 1} OFFSET $${selectParams.length + 2}`;
      selectParams.push(pageSize, offset);

      const countResult = await pool.query(countQuery, countParams);
      const result = await pool.query(selectQuery, selectParams);

      return {
        items: result.rows,
        total: parseInt(countResult.rows[0].count),
      };
    } catch (error) {
      console.error('[WeKnoraUserService] Failed to get tenant users:', error);
      return { items: [], total: 0 };
    }
  }
}

export const weknoraUserService = new WeKnoraUserService();
