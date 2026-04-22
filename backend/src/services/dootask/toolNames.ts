/**
 * 28 个工具名清单（规范: mcp__<server>__<tool>）
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
  // projects (4)
  'mcp__dootask__list_projects',
  'mcp__dootask__get_project',
  'mcp__dootask__create_project',
  'mcp__dootask__update_project',
  // dialogs (3)
  'mcp__dootask__search_dialogs',
  'mcp__dootask__send_message',
  'mcp__dootask__get_message_list',
  // reports (6)
  'mcp__dootask__list_received_reports',
  'mcp__dootask__get_report_detail',
  'mcp__dootask__generate_report_template',
  'mcp__dootask__create_report',
  'mcp__dootask__list_my_reports',
  'mcp__dootask__mark_reports_read',
  // files (4)
  'mcp__dootask__list_files',
  'mcp__dootask__search_files',
  'mcp__dootask__get_file_detail',
  'mcp__dootask__fetch_file_content',
  // search (1)
  'mcp__dootask__intelligent_search',
] as const;

export type DootaskToolName = typeof DOOTASK_TOOL_NAMES[number];
