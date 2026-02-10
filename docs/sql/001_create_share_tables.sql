-- docs/sql/001_create_share_tables.sql
-- 知识库分享功能数据库迁移脚本
-- 在 WeKnora 数据库中执行

-- 1. 分享记录表
CREATE TABLE shares (
    id VARCHAR(36) PRIMARY KEY,
    share_type VARCHAR(20) NOT NULL,        -- 'knowledge_base' | 'knowledge'
    target_id VARCHAR(36) NOT NULL,         -- 知识库ID 或 文档ID
    target_name VARCHAR(255),               -- 冗余名称便于展示
    target_kb_id VARCHAR(36),               -- 文档分享时记录所属知识库ID

    share_mode VARCHAR(20) NOT NULL,        -- 'public' | 'user' | 'link'
    share_link_token VARCHAR(64) UNIQUE,    -- 链接分享 token
    link_password VARCHAR(255),             -- 链接密码（可选，哈希存储）

    permissions VARCHAR(20) DEFAULT 'read', -- 当前阶段仅支持 'read'
    status VARCHAR(20) DEFAULT 'active',    -- 'active' | 'disabled'

    owner_tenant_id BIGINT NOT NULL,        -- 分享者租户ID
    owner_user_id VARCHAR(36) NOT NULL,     -- 分享者用户ID
    owner_username VARCHAR(100),            -- 分享者用户名（冗余）

    view_count INT DEFAULT 0,               -- 访问次数
    last_accessed_at TIMESTAMP,             -- 最后访问时间
    expires_at TIMESTAMP,                   -- 过期时间

    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    deleted_at TIMESTAMP                    -- 软删除
);

CREATE INDEX idx_shares_type_target ON shares(share_type, target_id);
CREATE INDEX idx_shares_mode_status ON shares(share_mode, status);
CREATE INDEX idx_shares_link_token ON shares(share_link_token);
CREATE INDEX idx_shares_owner ON shares(owner_user_id);
CREATE INDEX idx_shares_deleted ON shares(deleted_at);

ALTER TABLE shares ADD CONSTRAINT chk_link_token
  CHECK (share_mode != 'link' OR share_link_token IS NOT NULL);

-- 2. 分享目标用户表
CREATE TABLE share_targets (
    id VARCHAR(36) PRIMARY KEY,
    share_id VARCHAR(36) NOT NULL,
    target_user_id VARCHAR(36) NOT NULL,
    target_username VARCHAR(100),
    target_email VARCHAR(255),
    target_tenant_id BIGINT,

    accepted_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),

    FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE,
    UNIQUE(share_id, target_user_id)
);

CREATE INDEX idx_share_targets_user ON share_targets(target_user_id);

-- 3. 分享访问日志表
CREATE TABLE share_access_logs (
    id VARCHAR(36) PRIMARY KEY,
    share_id VARCHAR(36) NOT NULL,
    accessor_user_id VARCHAR(36),
    accessor_ip VARCHAR(45),
    access_type VARCHAR(20),                -- 'view' | 'download' | 'copy'
    created_at TIMESTAMP DEFAULT NOW(),

    FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE
);

CREATE INDEX idx_share_access_logs_share ON share_access_logs(share_id);
