/**
 * 聚合所有 DooTask 工具（31 个）
 */

import { buildUsersTools } from './users.js';
import { buildTasksTools } from './tasks.js';
import { buildProjectsTools } from './projects.js';
import { buildDialogsTools } from './dialogs.js';
import { buildReportsTools } from './reports.js';
import { buildFilesTools } from './files.js';
import { buildSearchTools } from './search.js';
import type { ToolContext } from './types.js';

/**
 * 构造全部 31 个 tool：
 *   users(2) + tasks(8) + projects(6) + dialogs(3) + reports(7) + files(4) + search(1) = 31
 *   其中 projects 6 = 原 mcp.js 4 个 + 新增 add_project_members/remove_project_members
 *   其中 reports 7 = 原 mcp.js 6 个 + Sprint 7-D Pass 3 新增 list_pending_reports
 */
export function buildAllTools(ctx: ToolContext) {
  return [
    ...buildUsersTools(ctx),
    ...buildTasksTools(ctx),
    ...buildProjectsTools(ctx),
    ...buildDialogsTools(ctx),
    ...buildReportsTools(ctx),
    ...buildFilesTools(ctx),
    ...buildSearchTools(ctx),
  ];
}
