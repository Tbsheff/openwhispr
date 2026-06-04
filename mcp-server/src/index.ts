import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { z } from "zod";
import { createDb as createNeonDb, type Db, type DbParam } from "./db.js";
import { registerMemoryTools } from "./memory.js";
import { registerMeetingTools } from "./meetings.js";
import { appendScopeFilters, resourceScopeSchema, toResourceScope } from "./scope.js";
import {
  type Env,
  verifyAccessToken as verifyJwtAccessToken,
  handleAuthorize,
  handleGitHubCallback,
  handleToken,
  handleRegister,
  handleRevoke,
  handleMetadata,
  handleResourceMetadata,
} from "./auth.js";

type HonoEnv = { Bindings: Env };

interface AppDeps {
  createDb(databaseUrl: string): Db;
  verifyAccessToken(token: string, env: Env): Promise<AuthInfo>;
}

const productionDeps: AppDeps = {
  createDb: createNeonDb,
  verifyAccessToken: verifyJwtAccessToken,
};

function notFoundContent(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

async function folderBelongsToScope(db: Db, folderId: number, workspaceId: string | null, teamId: string | null): Promise<boolean> {
  const row = await db.getOne<{ id: number }>(
    `SELECT id FROM folders WHERE id = $1 AND workspace_id IS NOT DISTINCT FROM $2 AND team_id IS NOT DISTINCT FROM $3`,
    [folderId, workspaceId, teamId]
  );
  return row !== null;
}

// ---------------------------------------------------------------------------
// Register MCP tools (db is injected per-request)
// ---------------------------------------------------------------------------

export function createMcpServer(db: Db, context: { authInfo?: AuthInfo; env?: Env } = {}): McpServer {
  const server = new McpServer({ name: "openwhispr", version: "1.0.0" });
  registerMemoryTools(server, db);
  registerMeetingTools(server, db, {
    authInfo: context.authInfo,
    githubOrg: context.env?.GITHUB_ORG,
    serverUrl: context.env?.SERVER_URL,
  });

  // -- Notes ----------------------------------------------------------------

  server.tool("list_notes", "List notes, optionally filtered by type or folder", {
    ...resourceScopeSchema,
    note_type: z.string().optional().describe("Filter by note type"),
    folder_id: z.number().optional().describe("Filter by folder ID"),
    limit: z.number().min(1).max(500).default(100).describe("Max notes to return"),
  }, async ({ note_type, folder_id, limit, workspace_id, team_id }) => {
    const conds = ["deleted_at IS NULL"];
    const params: DbParam[] = [];
    const scope = toResourceScope({ workspace_id, team_id });
    appendScopeFilters(conds, params, scope);
    if (note_type) { conds.push(`note_type = $${params.length + 1}`); params.push(note_type); }
    if (folder_id !== undefined) { conds.push(`folder_id = $${params.length + 1}`); params.push(folder_id); }
    params.push(limit);
    const rows = await db.getMany(`SELECT id, title, note_type, folder_id, workspace_id, team_id, audio_duration_seconds, created_by, created_at, updated_at FROM notes WHERE ${conds.join(" AND ")} ORDER BY updated_at DESC LIMIT $${params.length}`, params);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  });

  server.tool("get_note", "Get a note by ID with full content", {
    ...resourceScopeSchema,
    id: z.number(),
  }, async ({ id, workspace_id, team_id }) => {
    const params: DbParam[] = [id];
    const filters = ["id = $1", "deleted_at IS NULL"];
    appendScopeFilters(filters, params, toResourceScope({ workspace_id, team_id }));
    const row = await db.getOne(`SELECT id, title, content, enhanced_content, note_type, transcript, participants, folder_id, workspace_id, team_id, audio_duration_seconds, created_by, created_at, updated_at FROM notes WHERE ${filters.join(" AND ")}`, params);
    if (!row) return { content: [{ type: "text", text: `Note ${id} not found.` }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(row, null, 2) }] };
  });

  server.tool("search_notes", "Full-text search across notes", {
    ...resourceScopeSchema,
    query: z.string().min(1), limit: z.number().min(1).max(100).default(20),
  }, async ({ query: q, limit, workspace_id, team_id }) => {
    const filters = [
      "deleted_at IS NULL",
      "to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,'') || ' ' || coalesce(enhanced_content,'')) @@ plainto_tsquery('english', $1)",
    ];
    const params: DbParam[] = [q];
    appendScopeFilters(filters, params, toResourceScope({ workspace_id, team_id }));
    params.push(limit);
    const rows = await db.getMany(
      `SELECT id, title, note_type, folder_id, workspace_id, team_id, created_at, updated_at FROM notes WHERE ${filters.join(" AND ")} ORDER BY updated_at DESC LIMIT $${params.length}`, params);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  });

  server.tool("create_note", "Create a new note", {
    ...resourceScopeSchema,
    title: z.string().default("Untitled Note"), content: z.string().default(""),
    note_type: z.string().default("personal"), folder_id: z.number().optional(),
    created_by: z.string().optional(),
  }, async ({ title, content, note_type, folder_id, created_by, workspace_id, team_id }) => {
    const noteWorkspaceId = workspace_id ?? null;
    const noteTeamId = team_id ?? null;
    if (folder_id !== undefined && !(await folderBelongsToScope(db, folder_id, noteWorkspaceId, noteTeamId))) {
      return notFoundContent(`Folder ${folder_id} not found.`);
    }
    const row = await db.getOne(`INSERT INTO notes (title, content, note_type, folder_id, created_by, workspace_id, team_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, title, note_type, folder_id, workspace_id, team_id, created_by, created_at, updated_at`, [title, content, note_type, folder_id ?? null, created_by ?? null, noteWorkspaceId, noteTeamId]);
    return { content: [{ type: "text", text: JSON.stringify(row, null, 2) }] };
  });

  server.tool("update_note", "Update a note", {
    ...resourceScopeSchema,
    id: z.number(), title: z.string().optional(), content: z.string().optional(),
    note_type: z.string().optional(), folder_id: z.number().optional(),
  }, async ({ id, title, content, note_type, folder_id, workspace_id, team_id }) => {
    const scope = toResourceScope({ workspace_id, team_id });
    if (folder_id !== undefined) {
      const noteParams: DbParam[] = [id];
      const noteFilters = ["id = $1", "deleted_at IS NULL"];
      appendScopeFilters(noteFilters, noteParams, scope);
      const existingNote = await db.getOne<{ workspace_id: string | null; team_id: string | null }>(
        `SELECT workspace_id, team_id FROM notes WHERE ${noteFilters.join(" AND ")}`,
        noteParams
      );
      if (!existingNote) return notFoundContent(`Note ${id} not found.`);
      if (!(await folderBelongsToScope(db, folder_id, existingNote.workspace_id, existingNote.team_id))) {
        return notFoundContent(`Folder ${folder_id} not found.`);
      }
    }

    const sets = ["updated_at = now()"]; const params: DbParam[] = []; let i = 1;
    if (title !== undefined) { sets.push(`title = $${i++}`); params.push(title); }
    if (content !== undefined) { sets.push(`content = $${i++}`); params.push(content); }
    if (note_type !== undefined) { sets.push(`note_type = $${i++}`); params.push(note_type); }
    if (folder_id !== undefined) { sets.push(`folder_id = $${i++}`); params.push(folder_id); }
    params.push(id);
    const filters = [`id = $${i}`, "deleted_at IS NULL"];
    appendScopeFilters(filters, params, scope);
    const row = await db.getOne(`UPDATE notes SET ${sets.join(", ")} WHERE ${filters.join(" AND ")} RETURNING id, title, note_type, folder_id, workspace_id, team_id, created_at, updated_at`, params);
    if (!row) return notFoundContent(`Note ${id} not found.`);
    return { content: [{ type: "text", text: JSON.stringify(row, null, 2) }] };
  });

  server.tool("delete_note", "Soft-delete a note", {
    ...resourceScopeSchema,
    id: z.number(),
  }, async ({ id, workspace_id, team_id }) => {
    const params: DbParam[] = [id];
    const filters = ["id = $1", "deleted_at IS NULL"];
    appendScopeFilters(filters, params, toResourceScope({ workspace_id, team_id }));
    const r = await db.query(`UPDATE notes SET deleted_at = now() WHERE ${filters.join(" AND ")}`, params);
    if (r.rowCount === 0) return { content: [{ type: "text", text: `Note ${id} not found.` }], isError: true };
    return { content: [{ type: "text", text: `Note ${id} deleted.` }] };
  });

  // -- Transcriptions -------------------------------------------------------

  server.tool("list_transcriptions", "List recent transcriptions", {
    ...resourceScopeSchema,
    limit: z.number().min(1).max(500).default(50),
  }, async ({ limit, workspace_id, team_id }) => {
    const filters = ["deleted_at IS NULL"];
    const params: DbParam[] = [];
    appendScopeFilters(filters, params, toResourceScope({ workspace_id, team_id }));
    params.push(limit);
    const rows = await db.getMany(`SELECT id, text, raw_text, has_audio, audio_duration_ms, provider, model, status, workspace_id, team_id, created_by, created_at FROM transcriptions WHERE ${filters.join(" AND ")} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  });

  server.tool("get_transcription", "Get a transcription by ID", {
    ...resourceScopeSchema,
    id: z.number(),
  }, async ({ id, workspace_id, team_id }) => {
    const params: DbParam[] = [id];
    const filters = ["id = $1", "deleted_at IS NULL"];
    appendScopeFilters(filters, params, toResourceScope({ workspace_id, team_id }));
    const row = await db.getOne(`SELECT id, text, raw_text, has_audio, audio_duration_ms, provider, model, status, error_message, error_code, workspace_id, team_id, created_by, created_at FROM transcriptions WHERE ${filters.join(" AND ")}`, params);
    if (!row) return { content: [{ type: "text", text: `Transcription ${id} not found.` }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(row, null, 2) }] };
  });

  server.tool("create_transcription", "Store a new transcription", {
    ...resourceScopeSchema,
    text: z.string(), raw_text: z.string().optional(), provider: z.string().optional(),
    model: z.string().optional(), created_by: z.string().optional(),
  }, async ({ text, raw_text, provider, model, created_by, workspace_id, team_id }) => {
    const row = await db.getOne(`INSERT INTO transcriptions (text, raw_text, provider, model, created_by, workspace_id, team_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, text, provider, model, workspace_id, team_id, created_by, created_at`, [text, raw_text ?? null, provider ?? null, model ?? null, created_by ?? null, workspace_id ?? null, team_id ?? null]);
    return { content: [{ type: "text", text: JSON.stringify(row, null, 2) }] };
  });

  // -- Folders --------------------------------------------------------------

  server.tool("list_folders", "List all folders", {
    ...resourceScopeSchema,
  }, async ({ workspace_id, team_id }) => {
    const filters: string[] = [];
    const params: DbParam[] = [];
    appendScopeFilters(filters, params, toResourceScope({ workspace_id, team_id }));
    const whereClause = filters.length > 0 ? ` WHERE ${filters.join(" AND ")}` : "";
    const rows = await db.getMany(`SELECT id, name, is_default, sort_order, workspace_id, team_id, created_at FROM folders${whereClause} ORDER BY sort_order`, params);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  });

  server.tool("create_folder", "Create a new folder", {
    ...resourceScopeSchema,
    name: z.string().min(1),
  }, async ({ name, workspace_id, team_id }) => {
    const scope = toResourceScope({ workspace_id, team_id });
    const maxFilters: string[] = [];
    const maxParams: DbParam[] = [];
    appendScopeFilters(maxFilters, maxParams, scope);
    const maxWhere = maxFilters.length > 0 ? ` WHERE ${maxFilters.join(" AND ")}` : "";
    const max = await db.getOne<{ max: number | null }>(`SELECT MAX(sort_order) as max FROM folders${maxWhere}`, maxParams);
    const row = await db.getOne(`INSERT INTO folders (name, sort_order, workspace_id, team_id) VALUES ($1, $2, $3, $4) RETURNING id, name, is_default, sort_order, workspace_id, team_id, created_at`, [name, (max?.max ?? 0) + 1, workspace_id ?? null, team_id ?? null]);
    return { content: [{ type: "text", text: JSON.stringify(row, null, 2) }] };
  });

  return server;
}

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

export function createApp(deps: AppDeps = productionDeps): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  // OAuth metadata discovery
  app.get("/.well-known/oauth-authorization-server", (c) => handleMetadata(c.env));
  app.get("/.well-known/oauth-protected-resource", (c) => handleResourceMetadata(c.env));
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => handleResourceMetadata(c.env));

  // OAuth endpoints
  app.get("/authorize", (c) => handleAuthorize(new URL(c.req.url), c.env));
  app.get("/github/callback", (c) => handleGitHubCallback(new URL(c.req.url), c.env));
  app.post("/token", (c) => handleToken(c.req.raw, c.env));
  app.post("/register", (c) => handleRegister(c.req.raw, c.env));
  app.post("/revoke", (c) => handleRevoke(c.req.raw, c.env));

  // Health check
  app.get("/health", (c) => c.json({ ok: true, version: "1.0.0" }));

  // MCP endpoint (bearer auth + stateless transport)
  app.all("/mcp", async (c) => {
    const authHeader = c.req.header("authorization") || "";
    const [scheme, token] = authHeader.split(" ");
    if (!token || scheme?.toLowerCase() !== "bearer") {
      return c.json({ error: "unauthorized" }, 401);
    }

    let authInfo;
    try {
      authInfo = await deps.verifyAccessToken(token, c.env);
    } catch {
      return c.json({ error: "invalid_token" }, 401);
    }

    const db = deps.createDb(c.env.DATABASE_URL);
    const mcpServer = createMcpServer(db, { authInfo, env: c.env });
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await mcpServer.connect(transport);

    try {
      return await transport.handleRequest(c.req.raw, { authInfo });
    } finally {
      await db.close?.();
    }
  });

  return app;
}

// ---------------------------------------------------------------------------
// Export Worker
// ---------------------------------------------------------------------------

export default createApp();
