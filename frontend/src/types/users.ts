export interface WeKnoraUser {
  id: string;
  username: string;
  email: string;
  avatar?: string;
  tenant_id?: number;
  is_active: boolean;
}

export interface ProjectUserMapping {
  projectId: string;
  allowAllUsers: boolean;
  allowedUserIds: string[];
  updatedAt: string;
}
