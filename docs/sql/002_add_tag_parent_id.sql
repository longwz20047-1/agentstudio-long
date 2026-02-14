-- docs/sql/002_add_tag_parent_id.sql
-- 知识库多级文档分类：为 knowledge_tags 添加 parent_id 列
-- 在 WeKnora 数据库中执行

ALTER TABLE knowledge_tags
  ADD COLUMN parent_id VARCHAR(36) REFERENCES knowledge_tags(id) ON DELETE SET NULL;

CREATE INDEX idx_knowledge_tags_parent ON knowledge_tags(parent_id);
