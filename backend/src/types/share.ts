// backend/src/types/share.ts

export type ShareType = 'knowledge_base' | 'knowledge';
export type ShareMode = 'public' | 'user' | 'link';
export type ShareStatus = 'active' | 'disabled';
export type SharePermission = 'read';  // 当前阶段仅支持 read

export interface Share {
  id: string;
  share_type: ShareType;
  target_id: string;
  target_name?: string;
  target_kb_id?: string;

  share_mode: ShareMode;
  share_link_token?: string;
  link_password?: string;

  permissions: SharePermission;
  status: ShareStatus;

  owner_tenant_id: number;
  owner_user_id: string;
  owner_username?: string;

  view_count: number;
  last_accessed_at?: Date;
  expires_at?: Date;

  created_at: Date;
  updated_at: Date;
  deleted_at?: Date;
}

export interface ShareTarget {
  id: string;
  share_id: string;
  target_user_id: string;
  target_username?: string;
  target_email?: string;
  target_tenant_id?: number;
  accepted_at?: Date;
  created_at: Date;
}

export interface ShareAccessLog {
  id: string;
  share_id: string;
  accessor_user_id?: string;
  accessor_ip?: string;
  access_type: 'view' | 'download' | 'copy';
  created_at: Date;
}

// API Request/Response types
export interface CreateShareRequest {
  userId: string;             // 分享创建者（从请求体获取）
  tenantId: number;
  username?: string;
  shareType: ShareType;
  targetId: string;
  shareMode: ShareMode;
  permissions?: SharePermission;
  expiresAt?: string;
  linkPassword?: string;
  targetUsers?: Array<{
    userId?: string;
    username?: string;
    email?: string;
  }>;
}

export interface ShareItem {
  shareId: string;
  shareType: ShareType;
  targetId: string;
  targetName: string;
  targetKbId?: string;
  targetKbName?: string;
  shareMode: ShareMode;
  permissions: SharePermission;
  status: ShareStatus | 'expired';
  ownerUserId: string;
  ownerUsername: string;
  viewCount: number;
  createdAt: string;
  expiresAt?: string;
}
