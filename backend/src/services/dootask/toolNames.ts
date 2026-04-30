/**
 * 42 个工具名清单（规范: mcp__<server>__<tool>）
 *
 * 必须和 tools/*.ts 的工具注册名保持同步。
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
  // projects (6)
  'mcp__dootask__list_projects',
  'mcp__dootask__get_project',
  'mcp__dootask__create_project',
  'mcp__dootask__update_project',
  'mcp__dootask__add_project_members',
  'mcp__dootask__remove_project_members',
  // dialogs (3)
  'mcp__dootask__search_dialogs',
  'mcp__dootask__send_message',
  'mcp__dootask__get_message_list',
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
  // taskReports (1) — Sprint 5a 任务级别上报
  'mcp__dootask__save_task_report',
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
] as const;

export type DootaskToolName = typeof DOOTASK_TOOL_NAMES[number];
