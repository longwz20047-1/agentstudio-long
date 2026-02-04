// backend/src/services/weknoraUserService.ts
import { Pool } from 'pg';
import { WeKnoraUser } from '../types/users.js';

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
}

export const weknoraUserService = new WeKnoraUserService();
