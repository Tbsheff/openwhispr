import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db, DbParam, Row } from "./db.js";
import {
  appendScopeFilters,
  authorizeResourceScope,
  hasResourceScope,
  resourceScopeSchema,
  scopeResponse,
  type AccessContext,
  type ResourceScope,
} from "./scope.js";

type CorpusSource = "memory" | "note" | "transcription";
type MemoryKind = "fact" | "preference" | "decision" | "task" | "note";

const memoryKindSchema = z.enum(["fact", "preference", "decision", "task", "note"]);

interface MemoryRow extends Row {
  id: number;
  title: string;
  content: string;
  kind: MemoryKind;
  tags: string[];
  source_type: string | null;
  source_id: string | null;
  workspace_id: string | null;
  team_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  score?: number;
  snippet?: string | null;
}

interface CorpusSearchRow extends Row {
  source: CorpusSource;
  id: number;
  title: string;
  note_type: string | null;
  kind: string | null;
  tags: string[] | null;
  folder_id: number | null;
  folder_name: string | null;
  workspace_id: string | null;
  team_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string | null;
  score: number;
  snippet: string | null;
  preview: string | null;
}

interface MemoryStatsRow extends Row {
  memory_count: number;
  note_count: number;
  transcription_count: number;
  folder_count: number;
  deleted_memory_count: number;
  deleted_note_count: number;
  deleted_transcription_count: number;
  latest_memory_at: string | null;
  latest_note_at: string | null;
  latest_transcription_at: string | null;
}

interface MemoryStatusRow extends Row {
  ok: number;
}

function jsonContent(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorContent(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function defaultMemoryTitle(content: string): string {
  const firstLine = content.trim().split(/\r?\n/, 1)[0] ?? "";
  return truncate(firstLine, 80) || "Untitled Memory";
}

function whereWithScope(baseFilters: string[], params: DbParam[], scope: ResourceScope, tableAlias?: string): string {
  const filters = [...baseFilters];
  appendScopeFilters(filters, params, scope, tableAlias);
  return filters.join(" AND ");
}

function noteFolderJoinPredicate(): string {
  return [
    "f.id = n.folder_id",
    "f.workspace_id IS NOT DISTINCT FROM n.workspace_id",
    "f.team_id IS NOT DISTINCT FROM n.team_id",
  ].join("\n        AND ");
}

function formatCorpusContext(rows: CorpusSearchRow[], maxChars: number): string {
  const lines: string[] = [];
  let total = 0;

  for (const row of rows) {
    const title = row.title || `${row.source} ${row.id}`;
    const date = row.updated_at ?? row.created_at;
    const body = row.snippet || row.preview || "";
    const line = `[${row.source}:${row.id}] ${title} (${date})\n${truncate(body, 500)}`;

    if (total + line.length + 2 > maxChars) break;
    lines.push(line);
    total += line.length + 2;
  }

  return lines.join("\n\n");
}

async function queryCorpus(
  db: Db,
  options: {
    query: string;
    limit: number;
    maxContextChars: number;
    includeMemories: boolean;
    includeNotes: boolean;
    includeTranscriptions: boolean;
    folderId?: number;
    scope: ResourceScope;
  }
) {
  const sources: string[] = [];
  const params: DbParam[] = [options.query, options.limit];
  let folderParam: number | null = null;

  if (options.includeMemories) {
    const memoryFilters = ["m.deleted_at IS NULL", "m.search_vector @@ cq.q"];
    appendScopeFilters(memoryFilters, params, options.scope, "m");
    sources.push(`
      SELECT
        'memory'::text AS source,
        m.id,
        m.title,
        null::text AS note_type,
        m.kind,
        m.tags,
        null::integer AS folder_id,
        null::text AS folder_name,
        m.workspace_id,
        m.team_id,
        m.created_by,
        m.created_at,
        m.updated_at,
        ts_rank_cd(m.search_vector, cq.q) AS score,
        ts_headline('english', concat_ws(' ', m.title, m.content, array_to_string(m.tags, ' ')), cq.q, 'MaxFragments=2, MinWords=8, MaxWords=24') AS snippet,
        left(m.content, 1200) AS preview
      FROM memories m
      CROSS JOIN corpus_query cq
      WHERE ${memoryFilters.join("\n        AND ")}
    `);
  }

  if (options.includeNotes) {
    const noteFilters = [
      "n.deleted_at IS NULL",
      "to_tsvector('english', concat_ws(' ', n.title, n.content, n.enhanced_content, n.transcript, n.participants)) @@ cq.q",
    ];
    appendScopeFilters(noteFilters, params, options.scope, "n");
    if (options.folderId !== undefined) {
      folderParam = params.push(options.folderId);
      noteFilters.push(`n.folder_id = $${folderParam}`);
    }
    sources.push(`
      SELECT
        'note'::text AS source,
        n.id,
        n.title,
        n.note_type,
        null::text AS kind,
        null::text[] AS tags,
        n.folder_id,
        f.name AS folder_name,
        n.workspace_id,
        n.team_id,
        n.created_by,
        n.created_at,
        n.updated_at,
        ts_rank_cd(
          to_tsvector('english', concat_ws(' ', n.title, n.content, n.enhanced_content, n.transcript, n.participants)),
          cq.q
        ) AS score,
        ts_headline('english', concat_ws(' ', n.enhanced_content, n.content, n.transcript), cq.q, 'MaxFragments=2, MinWords=8, MaxWords=24') AS snippet,
        left(concat_ws(' ', n.enhanced_content, n.content, n.transcript), 1200) AS preview
      FROM notes n
      LEFT JOIN folders f ON ${noteFolderJoinPredicate()}
      CROSS JOIN corpus_query cq
      WHERE ${noteFilters.join("\n        AND ")}
    `);
  }

  if (options.includeTranscriptions) {
    const transcriptionFilters = [
      "t.deleted_at IS NULL",
      "to_tsvector('english', concat_ws(' ', t.text, t.raw_text, t.provider, t.model)) @@ cq.q",
    ];
    appendScopeFilters(transcriptionFilters, params, options.scope, "t");
    sources.push(`
      SELECT
        'transcription'::text AS source,
        t.id,
        concat('Transcription ', t.id)::text AS title,
        null::text AS note_type,
        null::text AS kind,
        null::text[] AS tags,
        null::integer AS folder_id,
        null::text AS folder_name,
        t.workspace_id,
        t.team_id,
        t.created_by,
        t.created_at,
        null::timestamptz AS updated_at,
        ts_rank_cd(to_tsvector('english', concat_ws(' ', t.text, t.raw_text, t.provider, t.model)), cq.q) AS score,
        ts_headline('english', concat_ws(' ', t.text, t.raw_text), cq.q, 'MaxFragments=2, MinWords=8, MaxWords=24') AS snippet,
        left(concat_ws(' ', t.text, t.raw_text), 1200) AS preview
      FROM transcriptions t
      CROSS JOIN corpus_query cq
      WHERE ${transcriptionFilters.join("\n        AND ")}
    `);
  }

  if (sources.length === 0) {
    return { query: options.query, searchMode: "postgres_full_text", hits: [], context: "" };
  }

  const rows = await db.getMany<CorpusSearchRow>(
    `
      WITH corpus_query AS (
        SELECT websearch_to_tsquery('english', $1) AS q
      ),
      corpus_items AS (
        ${sources.join("\nUNION ALL\n")}
      )
      SELECT source, id, title, note_type, kind, tags, folder_id, folder_name, workspace_id, team_id, created_by, created_at, updated_at, score, snippet, preview
      FROM corpus_items
      ORDER BY score DESC, updated_at DESC NULLS LAST, created_at DESC
      LIMIT $2
    `,
    params
  );

  return {
    query: options.query,
    searchMode: "postgres_full_text",
    filters: {
      folderId: options.folderId ?? null,
      folderFilterAppliedTo: options.folderId === undefined || !options.includeNotes ? [] : ["note"],
      unscopedSources: options.folderId === undefined
        ? []
        : [
          ...(options.includeMemories ? ["memory"] : []),
          ...(options.includeTranscriptions ? ["transcription"] : []),
        ],
      ...(hasResourceScope(options.scope) ? scopeResponse(options.scope) : {}),
    },
    hits: rows.map((row) => ({
      id: `${row.source}:${row.id}`,
      source: row.source,
      recordId: row.id,
      title: row.title,
      noteType: row.note_type,
      kind: row.kind,
      tags: row.tags,
      folderId: row.folder_id,
      folderName: row.folder_name,
      workspaceId: row.workspace_id,
      teamId: row.team_id,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      score: row.score,
      snippet: row.snippet,
    })),
    context: formatCorpusContext(rows, options.maxContextChars),
  };
}

async function searchMemories(db: Db, options: { query: string; limit: number; kind?: MemoryKind; tags?: string[]; scope: ResourceScope }): Promise<MemoryRow[]> {
  const filters = ["deleted_at IS NULL", "search_vector @@ plainto_tsquery('english', $1)"];
  const params: DbParam[] = [options.query];
  appendScopeFilters(filters, params, options.scope);
  let i = params.length + 1;

  if (options.kind) {
    filters.push(`kind = $${i++}`);
    params.push(options.kind);
  }

  if (options.tags && options.tags.length > 0) {
    filters.push(`tags && $${i++}::text[]`);
    params.push(options.tags);
  }

  params.push(options.limit);

  return db.getMany<MemoryRow>(`
    SELECT
      id, title, content, kind, tags, source_type, source_id, workspace_id, team_id, created_by, created_at, updated_at,
      ts_rank_cd(search_vector, plainto_tsquery('english', $1)) AS score,
      ts_headline('english', concat_ws(' ', title, content, array_to_string(tags, ' ')), plainto_tsquery('english', $1), 'MaxFragments=2, MinWords=8, MaxWords=24') AS snippet
    FROM memories
    WHERE ${filters.join(" AND ")}
    ORDER BY score DESC, updated_at DESC
    LIMIT $${i}
  `, params);
}

async function getMemoryStats(db: Db, scope: ResourceScope): Promise<MemoryStatsRow> {
  const params: DbParam[] = [];
  const memoryActiveWhere = whereWithScope(["deleted_at IS NULL"], params, scope);
  const noteActiveWhere = whereWithScope(["deleted_at IS NULL"], params, scope);
  const transcriptionActiveWhere = whereWithScope(["deleted_at IS NULL"], params, scope);
  const folderWhere = whereWithScope([], params, scope);
  const memoryDeletedWhere = whereWithScope(["deleted_at IS NOT NULL"], params, scope);
  const noteDeletedWhere = whereWithScope(["deleted_at IS NOT NULL"], params, scope);
  const transcriptionDeletedWhere = whereWithScope(["deleted_at IS NOT NULL"], params, scope);
  const latestMemoryWhere = whereWithScope(["deleted_at IS NULL"], params, scope);
  const latestNoteWhere = whereWithScope(["deleted_at IS NULL"], params, scope);
  const latestTranscriptionWhere = whereWithScope(["deleted_at IS NULL"], params, scope);
  const stats = await db.getOne<MemoryStatsRow>(`
    SELECT
      (SELECT count(*)::int FROM memories WHERE ${memoryActiveWhere}) AS memory_count,
      (SELECT count(*)::int FROM notes WHERE ${noteActiveWhere}) AS note_count,
      (SELECT count(*)::int FROM transcriptions WHERE ${transcriptionActiveWhere}) AS transcription_count,
      (SELECT count(*)::int FROM folders${folderWhere ? ` WHERE ${folderWhere}` : ""}) AS folder_count,
      (SELECT count(*)::int FROM memories WHERE ${memoryDeletedWhere}) AS deleted_memory_count,
      (SELECT count(*)::int FROM notes WHERE ${noteDeletedWhere}) AS deleted_note_count,
      (SELECT count(*)::int FROM transcriptions WHERE ${transcriptionDeletedWhere}) AS deleted_transcription_count,
      (SELECT max(updated_at) FROM memories WHERE ${latestMemoryWhere}) AS latest_memory_at,
      (SELECT max(updated_at) FROM notes WHERE ${latestNoteWhere}) AS latest_note_at,
      (SELECT max(created_at) FROM transcriptions WHERE ${latestTranscriptionWhere}) AS latest_transcription_at
  `, params);

  if (!stats) throw new Error("Memory stats query returned no rows");
  return stats;
}

export function registerMemoryTools(server: McpServer, db: Db, accessContext: AccessContext): void {
  server.tool("remember_memory", "Create a durable OpenWhispr memory for facts, preferences, decisions, tasks, or notes.", {
    ...resourceScopeSchema,
    title: z.string().optional(),
    content: z.string().min(1),
    kind: memoryKindSchema.default("fact"),
    tags: z.array(z.string()).default([]),
    source_type: z.string().optional(),
    source_id: z.string().optional(),
    created_by: z.string().optional(),
  }, async ({ title, content, kind, tags, source_type, source_id, created_by, workspace_id, team_id }) => {
    try {
      const scope = authorizeResourceScope({ workspace_id, team_id }, accessContext);
      const row = await db.getOne<MemoryRow>(`
        INSERT INTO memories (title, content, kind, tags, source_type, source_id, created_by, workspace_id, team_id)
        VALUES ($1, $2, $3, $4::text[], $5, $6, $7, $8, $9)
        RETURNING id, title, content, kind, tags, source_type, source_id, workspace_id, team_id, created_by, created_at, updated_at
      `, [title ?? defaultMemoryTitle(content), content, kind, tags, source_type ?? null, source_id ?? null, created_by ?? null, scope.workspaceId ?? null, scope.teamId ?? null]);
      return jsonContent(row);
    } catch (error) {
      return errorContent(errorMessage(error));
    }
  });

  server.tool("search_memories", "Full-text search durable OpenWhispr memories with optional kind and tag filters.", {
    ...resourceScopeSchema,
    query: z.string().min(1),
    kind: memoryKindSchema.optional(),
    tags: z.array(z.string()).optional(),
    limit: z.number().int().min(1).max(100).default(20),
  }, async ({ query, kind, tags, limit, workspace_id, team_id }) => {
    try {
      const scope = authorizeResourceScope({ workspace_id, team_id }, accessContext);
      return jsonContent(await searchMemories(db, { query, kind, tags, limit, scope }));
    } catch (error) {
      return errorContent(errorMessage(error));
    }
  });

  server.tool("get_memory", "Get one durable OpenWhispr memory by ID.", {
    ...resourceScopeSchema,
    id: z.number().int().min(1),
  }, async ({ id, workspace_id, team_id }) => {
    try {
      const scope = authorizeResourceScope({ workspace_id, team_id }, accessContext);
      const params: DbParam[] = [id];
      const filters = ["id = $1", "deleted_at IS NULL"];
      appendScopeFilters(filters, params, scope);
      const row = await db.getOne<MemoryRow>(`
        SELECT id, title, content, kind, tags, source_type, source_id, workspace_id, team_id, created_by, created_at, updated_at
        FROM memories
        WHERE ${filters.join(" AND ")}
      `, params);
      if (!row) return { content: [{ type: "text" as const, text: `Memory ${id} not found.` }], isError: true };
      return jsonContent(row);
    } catch (error) {
      return errorContent(errorMessage(error));
    }
  });

  server.tool("update_memory", "Update an existing durable OpenWhispr memory.", {
    ...resourceScopeSchema,
    id: z.number().int().min(1),
    title: z.string().optional(),
    content: z.string().optional(),
    kind: memoryKindSchema.optional(),
    tags: z.array(z.string()).optional(),
    source_type: z.string().nullable().optional(),
    source_id: z.string().nullable().optional(),
  }, async ({ id, title, content, kind, tags, source_type, source_id, workspace_id, team_id }) => {
    try {
      const scope = authorizeResourceScope({ workspace_id, team_id }, accessContext);
      const sets = ["updated_at = now()"];
      const params: DbParam[] = [];
      let i = 1;

      if (title !== undefined) { sets.push(`title = $${i++}`); params.push(title); }
      if (content !== undefined) { sets.push(`content = $${i++}`); params.push(content); }
      if (kind !== undefined) { sets.push(`kind = $${i++}`); params.push(kind); }
      if (tags !== undefined) { sets.push(`tags = $${i++}::text[]`); params.push(tags); }
      if (source_type !== undefined) { sets.push(`source_type = $${i++}`); params.push(source_type); }
      if (source_id !== undefined) { sets.push(`source_id = $${i++}`); params.push(source_id); }

      params.push(id);
      const filters = [`id = $${i}`, "deleted_at IS NULL"];
      appendScopeFilters(filters, params, scope);
      const row = await db.getOne<MemoryRow>(`
        UPDATE memories
        SET ${sets.join(", ")}
        WHERE ${filters.join(" AND ")}
        RETURNING id, title, content, kind, tags, source_type, source_id, workspace_id, team_id, created_by, created_at, updated_at
      `, params);

      if (!row) return { content: [{ type: "text" as const, text: `Memory ${id} not found.` }], isError: true };
      return jsonContent(row);
    } catch (error) {
      return errorContent(errorMessage(error));
    }
  });

  server.tool("delete_memory", "Soft-delete a durable OpenWhispr memory.", {
    ...resourceScopeSchema,
    id: z.number().int().min(1),
  }, async ({ id, workspace_id, team_id }) => {
    try {
      const scope = authorizeResourceScope({ workspace_id, team_id }, accessContext);
      const params: DbParam[] = [id];
      const filters = ["id = $1", "deleted_at IS NULL"];
      appendScopeFilters(filters, params, scope);
      const result = await db.query(`UPDATE memories SET deleted_at = now(), updated_at = now() WHERE ${filters.join(" AND ")}`, params);
      if (result.rowCount === 0) return { content: [{ type: "text" as const, text: `Memory ${id} not found.` }], isError: true };
      return { content: [{ type: "text" as const, text: `Memory ${id} deleted.` }] };
    } catch (error) {
      return errorContent(errorMessage(error));
    }
  });

  server.tool("memory_query", "Search OpenWhispr memory across durable memories, notes, and transcriptions. Returns ranked hits plus a formatted context block for agents.", {
    ...resourceScopeSchema,
    query: z.string().min(1),
    limit: z.number().int().min(1).max(50).default(10),
    max_context_chars: z.number().int().min(500).max(20000).default(8000),
    include_memories: z.boolean().default(true),
    include_notes: z.boolean().default(true),
    include_transcriptions: z.boolean().default(true),
    folder_id: z.number().int().optional(),
  }, async ({ query, limit, max_context_chars, include_memories, include_notes, include_transcriptions, folder_id, workspace_id, team_id }) => {
    try {
      const scope = authorizeResourceScope({ workspace_id, team_id }, accessContext);
      return jsonContent(await queryCorpus(db, {
        query,
        limit,
        maxContextChars: max_context_chars,
        includeMemories: include_memories,
        includeNotes: include_notes,
        includeTranscriptions: include_transcriptions,
        folderId: folder_id,
        scope,
      }));
    } catch (error) {
      return errorContent(errorMessage(error));
    }
  });

  server.tool("memory_stats", "Return OpenWhispr memory corpus counts across durable memories, notes, transcriptions, folders, and deleted records.", {
    ...resourceScopeSchema,
  }, async ({ workspace_id, team_id }) => {
    try {
      return jsonContent(await getMemoryStats(db, authorizeResourceScope({ workspace_id, team_id }, accessContext)));
    } catch (error) {
      return errorContent(errorMessage(error));
    }
  });

  server.tool("memory_status", "Health check for the OpenWhispr memory store and search backend.", {
    ...resourceScopeSchema,
  }, async ({ workspace_id, team_id }) => {
    try {
      const startedAt = Date.now();
      const row = await db.getOne<MemoryStatusRow>("SELECT 1::int AS ok");
      const scope = authorizeResourceScope({ workspace_id, team_id }, accessContext);
      const stats = await getMemoryStats(db, scope);
      return jsonContent({
        healthy: row?.ok === 1,
        store: "postgres",
        searchMode: "postgres_full_text",
        latencyMs: Date.now() - startedAt,
        ...(hasResourceScope(scope) ? { scope: scopeResponse(scope) } : {}),
        stats,
      });
    } catch (error) {
      return errorContent(errorMessage(error));
    }
  });
}
