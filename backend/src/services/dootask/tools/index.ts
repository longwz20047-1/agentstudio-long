/**
 * 聚合所有 DooTask 工具（47 个）
 */

import { buildUsersTools } from './users.js';
import { buildTasksTools } from './tasks.js';
import { buildProjectsTools } from './projects.js';
import { buildColumnsTools } from './columns.js';
import { buildDialogsTools } from './dialogs.js';
import { buildReportsTools } from './reports.js';
import { buildFilesTools } from './files.js';
import { buildSearchTools } from './search.js';
import { buildTaskReportsTools } from './taskReports.js';
import { buildReportTemplatesTools } from './reportTemplates.js';
import { buildReportFieldsTools } from './reportFields.js';
import type { ToolContext } from './types.js';

/**
 * 构造全部 47 个 tool：
 *   users(2) + tasks(8) + projects(6) + columns(5) + dialogs(3) + reports(7) + files(4) + search(1)
 *   + taskReports(1) + reportTemplates(6) + reportFields(4) = 47
 *
 *   - projects 6 = 原 mcp.js 4 个 + add_project_members / remove_project_members
 *   - columns  5 = list_project_columns + create_column + create_columns_batch
 *                  + update_column + delete_column（补齐 column 写操作闭环）
 *   - reports  7 = 原 mcp.js 6 个 + Sprint 7-D Pass 3 list_pending_reports
 *   - taskReports(1) + reportTemplates(6) + reportFields(4) = Sprint 5a 11 个新增
 *     对接 dootask 报告通道 Sprint 1-7-B 全部 endpoint
 *     注：upload_report_attachment（multipart）暂跳过 — Sprint 8/9 前端 UI 实施
 */
export function buildAllTools(ctx: ToolContext) {
  return [
    ...buildUsersTools(ctx),
    ...buildTasksTools(ctx),
    ...buildProjectsTools(ctx),
    ...buildColumnsTools(ctx),
    ...buildDialogsTools(ctx),
    ...buildReportsTools(ctx),
    ...buildFilesTools(ctx),
    ...buildSearchTools(ctx),
    ...buildTaskReportsTools(ctx),
    ...buildReportTemplatesTools(ctx),
    ...buildReportFieldsTools(ctx),
  ];
}
