/**
 * 聚合所有 DooTask 工具（68 个）
 */

import { buildUsersTools } from './users.js';
import { buildTasksTools } from './tasks.js';
import { buildTaskLifecycleTools } from './taskLifecycle.js';
import { buildTaskPrioritiesTools } from './taskPriorities.js';
import { buildTaskStatsTools } from './taskStats.js';
import { buildProjectsTools } from './projects.js';
import { buildProjectAdvancedTools } from './projectAdvanced.js';
import { buildProjectTagsTools } from './projectTags.js';
import { buildColumnsTools } from './columns.js';
import { buildDialogsTools } from './dialogs.js';
import { buildDialogMessagesTools } from './dialogMessages.js';
import { buildReportsTools } from './reports.js';
import { buildFilesTools } from './files.js';
import { buildSearchTools } from './search.js';
import { buildTaskReportsTools } from './taskReports.js';
import { buildReportTemplatesTools } from './reportTemplates.js';
import { buildReportFieldsTools } from './reportFields.js';
import { buildReportDashboardTools } from './reportDashboard.js';
import type { ToolContext } from './types.js';

/**
 * 构造全部 68 个 tool：
 *   users(2) + tasks(8) + taskLifecycle(3) + taskPriorities(1) + taskStats(1)
 *   + projects(6) + projectAdvanced(3) + projectTags(4)
 *   + columns(5) + dialogs(3) + dialogMessages(6) + reports(7) + files(4) + search(1)
 *   + taskReports(1) + reportTemplates(6) + reportFields(4) + reportDashboard(3) = 68
 *
 *   - projects 6 = 原 mcp.js 4 个 + add_project_members / remove_project_members
 *   - projectAdvanced 3 = transfer_project_owner + get_project_permission
 *                  + update_project_permission（项目转让 + 权限矩阵读改；管理员场景）
 *   - projectTags 4 = list_project_tags + create_project_tag + update_project_tag
 *                  + delete_project_tag（任务画像三轴模型 5b：多维标签 N:N 自由刻画）
 *   - taskPriorities 1 = list_task_priorities（任务画像三轴模型 5a：系统级优先级档位查询）
 *                  与 create_task / update_task 的 p_level/p_name/p_color 三字段闭环
 *   - taskStats 1 = get_task_completion_stats（5 维度任务完成率统计 + equal/priority 加权）
 *                  支持自然语言完成率追问：项目/列/标签/优先级/负责人 任意分组维度
 *   - columns  5 = list_project_columns + create_column + create_columns_batch
 *                  + update_column + delete_column（补齐 column 写操作闭环）
 *   - taskLifecycle 3 = archive_task + move_task + copy_task
 *                  （归档/还原 + 跨项目跨列复合移动 + 复制；与 column 体系强耦合）
 *   - dialogMessages 6 = send_file_message + send_task_card + send_location_message
 *                  + withdraw_message + forward_message + mark_messages_read
 *                  （富消息发送 + 消息管理；与 dialogs.ts 文本通道互补）
 *   - reports  7 = 原 mcp.js 6 个 + Sprint 7-D Pass 3 list_pending_reports
 *   - taskReports(1) + reportTemplates(6) + reportFields(4) = Sprint 5a 11 个新增
 *     对接 dootask 报告通道 Sprint 1-7-B 全部 endpoint
 *     注：upload_report_attachment（multipart）暂跳过 — Sprint 8/9 前端 UI 实施
 *   - reportDashboard 3 = Sprint 7-B Pass 2 闭环统计层（query/drill/export）
 *     注：charts/save_chart/delete_chart 占位端点跳过（dootask 后端 retError，Sprint 9 落表）
 */
export function buildAllTools(ctx: ToolContext) {
  return [
    ...buildUsersTools(ctx),
    ...buildTasksTools(ctx),
    ...buildTaskLifecycleTools(ctx),
    ...buildTaskPrioritiesTools(ctx),
    ...buildTaskStatsTools(ctx),
    ...buildProjectsTools(ctx),
    ...buildProjectAdvancedTools(ctx),
    ...buildProjectTagsTools(ctx),
    ...buildColumnsTools(ctx),
    ...buildDialogsTools(ctx),
    ...buildDialogMessagesTools(ctx),
    ...buildReportsTools(ctx),
    ...buildFilesTools(ctx),
    ...buildSearchTools(ctx),
    ...buildTaskReportsTools(ctx),
    ...buildReportTemplatesTools(ctx),
    ...buildReportFieldsTools(ctx),
    ...buildReportDashboardTools(ctx),
  ];
}
