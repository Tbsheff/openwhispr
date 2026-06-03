-- Add workspace/team scope fields for team sharing while preserving NULL personal/default records.

ALTER TABLE folders ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE folders ADD COLUMN IF NOT EXISTS team_id TEXT;

ALTER TABLE notes ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS team_id TEXT;

ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS team_id TEXT;

ALTER TABLE memories ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS team_id TEXT;

ALTER TABLE folders DROP CONSTRAINT IF EXISTS folders_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_scope_name_unique
ON folders (name, COALESCE(workspace_id, ''), COALESCE(team_id, ''));

CREATE INDEX IF NOT EXISTS idx_folders_workspace_team ON folders(workspace_id, team_id);
CREATE INDEX IF NOT EXISTS idx_folders_team ON folders(team_id);

CREATE INDEX IF NOT EXISTS idx_notes_workspace_team_deleted ON notes(workspace_id, team_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_notes_team_deleted ON notes(team_id, deleted_at);

CREATE INDEX IF NOT EXISTS idx_transcriptions_workspace_team_deleted ON transcriptions(workspace_id, team_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_transcriptions_team_deleted ON transcriptions(team_id, deleted_at);

CREATE INDEX IF NOT EXISTS idx_memories_workspace_team_deleted ON memories(workspace_id, team_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_memories_team_deleted ON memories(team_id, deleted_at);
