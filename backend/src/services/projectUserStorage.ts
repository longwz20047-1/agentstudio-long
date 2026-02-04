// backend/src/services/projectUserStorage.ts
import * as fs from 'fs';
import * as path from 'path';
import { ProjectUserMapping, ProjectUserStore } from '../types/users';
import { CLAUDE_AGENT_DIR } from '../config/paths';

const PROJECT_USERS_FILE = path.join(CLAUDE_AGENT_DIR, 'project-users.json');

export class ProjectUserStorage {
  private cache: ProjectUserStore | null = null;

  private loadStore(): ProjectUserStore {
    if (this.cache) {
      return this.cache;
    }

    try {
      if (fs.existsSync(PROJECT_USERS_FILE)) {
        const content = fs.readFileSync(PROJECT_USERS_FILE, 'utf-8');
        this.cache = JSON.parse(content);
        return this.cache!;
      }
    } catch (error) {
      console.error('[ProjectUserStorage] Failed to load project-users.json:', error);
    }

    this.cache = {};
    return this.cache;
  }

  private saveStore(store: ProjectUserStore): void {
    try {
      const dir = path.dirname(PROJECT_USERS_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(PROJECT_USERS_FILE, JSON.stringify(store, null, 2));
      this.cache = store;
    } catch (error) {
      console.error('[ProjectUserStorage] Failed to save project-users.json:', error);
      throw error;
    }
  }

  getProjectUsers(projectId: string): ProjectUserMapping | null {
    const store = this.loadStore();
    return store[projectId] || null;
  }

  setProjectUsers(
    projectId: string,
    allowAllUsers: boolean,
    allowedUserIds: string[]
  ): ProjectUserMapping {
    const store = this.loadStore();

    const mapping: ProjectUserMapping = {
      projectId,
      allowAllUsers,
      allowedUserIds: allowAllUsers ? [] : allowedUserIds,
      updatedAt: new Date().toISOString(),
    };

    store[projectId] = mapping;
    this.saveStore(store);

    return mapping;
  }

  removeProjectUsers(projectId: string): void {
    const store = this.loadStore();
    delete store[projectId];
    this.saveStore(store);
  }

  /**
   * 检查用户是否有权访问项目
   * 用于后续权限校验扩展
   */
  canUserAccessProject(projectId: string, userId: string): boolean {
    const mapping = this.getProjectUsers(projectId);

    // 没有配置 = 允许所有人访问（向后兼容）
    if (!mapping) {
      return true;
    }

    // 允许所有用户
    if (mapping.allowAllUsers) {
      return true;
    }

    // 检查用户是否在允许列表中
    return mapping.allowedUserIds.includes(userId);
  }

  getAllMappings(): ProjectUserStore {
    return this.loadStore();
  }

  clearCache(): void {
    this.cache = null;
  }
}

export const projectUserStorage = new ProjectUserStorage();
