// backend/src/types/tag.ts

export interface TagItem {
  id: string;
  name: string;
  color: string | null;
  sort_order: number;
  parent_id: string | null;
  knowledge_count: number;
}

export interface TagTreeNode extends TagItem {
  children: TagTreeNode[];
}

export interface CreateTagRequest {
  name: string;
  parent_id?: string;
  color?: string;
  sort_order?: number;
}

export interface UpdateTagRequest {
  name?: string;
  parent_id?: string | null;  // null = move to root, undefined = no change
  color?: string;
  sort_order?: number;
}

export interface ReorderRequest {
  items: Array<{ id: string; parent_id: string | null; sort_order: number }>;
}

export type DeleteStrategy = 'promote' | 'cascade';
