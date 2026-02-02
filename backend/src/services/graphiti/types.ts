/**
 * Graphiti Memory Context
 *
 * Context for Graphiti memory search integration.
 * Similar to WeknoraContext but with user_id for memory isolation.
 */
export interface GraphitiContext {
  /** Graphiti REST API base URL */
  base_url: string;           // e.g., "http://192.168.100.30:8000"

  /** User ID (required for memory isolation) */
  user_id: string;            // Auto-converted to group_id = "user_{user_id}"

  /** Additional group_ids (optional, for shared memories) */
  group_ids?: string[];       // e.g., ["shared", "project_abc"]

  /** API authentication key (optional, Graphiti currently has no auth) */
  api_key?: string;
}
