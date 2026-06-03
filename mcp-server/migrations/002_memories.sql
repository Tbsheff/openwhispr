-- Durable agent memory + full-text search support.

CREATE TABLE IF NOT EXISTS memories (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'fact',
  tags TEXT[] NOT NULL DEFAULT '{}',
  source_type TEXT,
  source_id TEXT,
  workspace_id TEXT,
  team_id TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  search_vector TSVECTOR NOT NULL DEFAULT ''::tsvector
);

CREATE OR REPLACE FUNCTION update_memories_search_vector()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.content, '')), 'B') ||
    setweight(to_tsvector('english', array_to_string(NEW.tags, ' ')), 'C');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS memories_search_vector_update ON memories;
CREATE TRIGGER memories_search_vector_update
BEFORE INSERT OR UPDATE OF title, content, tags
ON memories
FOR EACH ROW
EXECUTE FUNCTION update_memories_search_vector();

CREATE INDEX IF NOT EXISTS idx_memories_deleted ON memories(deleted_at);
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);
CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_memories_search ON memories USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_memories_workspace_team_deleted ON memories(workspace_id, team_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_memories_team_deleted ON memories(team_id, deleted_at);
