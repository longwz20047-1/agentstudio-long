/**
 * 69 个工具名清单（规范: mcp__<server>__<tool>）
 *
 * 必须和 tools/*.ts 的工具注册名保持同步（buildAllTools 也是 69）。
 * 因为 allowedTools 注册在 AgentStudio 层（integrateDootaskMcpServer），
 * 而工具实现在 tools/ 下，两处分离 —— 维护时一并更新。
 */
export const DOOTASK_TOOL_NAMES = [
  // users (2)
  'mcp__dootask__get_users_basic',
  'mcp__dootask__search_users',
  // tasks (8)
  'mcp__dootask__list_tasks',
  'mcp__dootask__get_task',
  'mcp__dootask__complete_task',
  'mcp__dootask__create_task',
  'mcp__dootask__update_task',
  'mcp__dootask__create_sub_task',
  'mcp__dootask__get_task_files',
  'mcp__dootask__delete_task',
  // taskLifecycle (3) — Sprint 5b 任务生命周期：归档/移动/复制
  'mcp__dootask__archive_task',
  'mcp__dootask__move_task',
  'mcp__dootask__copy_task',
  // taskPriorities (1) — Sprint 5b 任务画像三轴 5a：系统级优先级档位查询
  'mcp__dootask__list_task_priorities',
  // taskStats (1) — Sprint 5b 完成率统计：5 维度分组
  'mcp__dootask__get_task_completion_stats',
  // projects (6)
  'mcp__dootask__list_projects',
  'mcp__dootask__get_project',
  'mcp__dootask__create_project',
  'mcp__dootask__update_project',
  'mcp__dootask__add_project_members',
  'mcp__dootask__remove_project_members',
  // projectAdvanced (3) — Sprint 5b 项目高级：转让 + 权限矩阵
  'mcp__dootask__transfer_project_owner',
  'mcp__dootask__get_project_permission',
  'mcp__dootask__update_project_permission',
  // projectTags (4) — Sprint 5b 任务画像三轴 5b：多维标签 N:N 自由刻画
  'mcp__dootask__list_project_tags',
  'mcp__dootask__create_project_tag',
  'mcp__dootask__update_project_tag',
  'mcp__dootask__delete_project_tag',
  // columns (5) — Sprint 5b 看板列：list + CRUD + batch
  'mcp__dootask__list_project_columns',
  'mcp__dootask__create_column',
  'mcp__dootask__create_columns_batch',
  'mcp__dootask__update_column',
  'mcp__dootask__delete_column',
  // dialogs (3)
  'mcp__dootask__search_dialogs',
  'mcp__dootask__send_message',
  'mcp__dootask__get_message_list',
  // dialogMessages (6) — Sprint 5b 富消息：文件/任务卡片/定位/撤回/转发/已读
  'mcp__dootask__send_file_message',
  'mcp__dootask__send_task_card',
  'mcp__dootask__send_location_message',
  'mcp__dootask__withdraw_message',
  'mcp__dootask__forward_message',
  'mcp__dootask__mark_messages_read',
  // reports (7)
  'mcp__dootask__list_received_reports',
  'mcp__dootask__get_report_detail',
  'mcp__dootask__generate_report_template',
  'mcp__dootask__create_report',
  'mcp__dootask__list_my_reports',
  'mcp__dootask__list_pending_reports',
  'mcp__dootask__mark_reports_read',
  // files (4)
  'mcp__dootask__list_files',
  'mcp__dootask__search_files',
  'mcp__dootask__get_file_detail',
  'mcp__dootask__fetch_file_content',
  // search (1)
  'mcp__dootask__intelligent_search',
  // taskReports (2) — Sprint 5a 任务级别上报 + 2026-05-07 按任务查
  'mcp__dootask__save_task_report',
  'mcp__dootask__list_task_reports',
  // reportTemplates (6) — Sprint 5a 报告模板
  'mcp__dootask__list_report_templates',
  'mcp__dootask__save_report_template',
  'mcp__dootask__resolve_report_template',
  'mcp__dootask__delete_report_template',
  'mcp__dootask__clone_report_template',
  'mcp__dootask__list_trigger_logs',
  // reportFields (4) — Sprint 5a 报告字段定义
  'mcp__dootask__list_report_fields',
  'mcp__dootask__save_report_field',
  'mcp__dootask__delete_report_field',
  'mcp__dootask__build_report_field_index',
  // reportDashboard (3) — Sprint 7-B Pass 2 仪表盘 query/drill/export
  'mcp__dootask__query_report_dashboard_data',
  'mcp__dootask__drill_report_dashboard',
  'mcp__dootask__export_report_dashboard_csv',
  // currentTime (1) — 实时当前时间（绕过 reuse session systemPrompt 缓存）
  'mcp__dootask__get_current_time',
] as const;

export type DootaskToolName = typeof DOOTASK_TOOL_NAMES[number];
