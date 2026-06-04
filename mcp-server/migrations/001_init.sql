-- OpenWhispr MCP Server — initial schema
-- Mirrors the desktop app's SQLite schema for shared team access.

CREATE TABLE IF NOT EXISTS folders (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  workspace_id TEXT,
  team_id TEXT,
  is_default BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_scope_name_unique
ON folders (name, COALESCE(workspace_id, ''), COALESCE(team_id, ''));
CREATE INDEX IF NOT EXISTS idx_folders_workspace_team ON folders(workspace_id, team_id);
CREATE INDEX IF NOT EXISTS idx_folders_team ON folders(team_id);

-- Seed default folders
INSERT INTO folders (name, is_default, sort_order)
VALUES ('Personal', true, 0), ('Meetings', true, 1)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS notes (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'Untitled Note',
  content TEXT NOT NULL DEFAULT '',
  note_type TEXT NOT NULL DEFAULT 'personal',
  source_file TEXT,
  audio_duration_seconds REAL,
  enhanced_content TEXT,
  enhancement_prompt TEXT,
  transcript TEXT,
  participants TEXT,
  folder_id INTEGER REFERENCES folders(id),
  workspace_id TEXT,
  team_id TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(folder_id);
CREATE INDEX IF NOT EXISTS idx_notes_type ON notes(note_type);
CREATE INDEX IF NOT EXISTS idx_notes_deleted ON notes(deleted_at);
CREATE INDEX IF NOT EXISTS idx_notes_workspace_team_deleted ON notes(workspace_id, team_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_notes_team_deleted ON notes(team_id, deleted_at);

CREATE TABLE IF NOT EXISTS transcriptions (
  id SERIAL PRIMARY KEY,
  text TEXT NOT NULL,
  raw_text TEXT,
  has_audio BOOLEAN NOT NULL DEFAULT false,
  audio_duration_ms INTEGER,
  provider TEXT,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'completed',
  error_message TEXT,
  error_code TEXT,
  workspace_id TEXT,
  team_id TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_transcriptions_deleted ON transcriptions(deleted_at);
CREATE INDEX IF NOT EXISTS idx_transcriptions_workspace_team_deleted ON transcriptions(workspace_id, team_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_transcriptions_team_deleted ON transcriptions(team_id, deleted_at);
