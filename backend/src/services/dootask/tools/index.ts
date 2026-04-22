/**
 * 聚合所有 DooTask 工具（28 个）
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
 * 构造全部 28 个 tool：
 *   users(2) + tasks(8) + projects(4) + dialogs(3) + reports(6) + files(4) + search(1) = 28
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
