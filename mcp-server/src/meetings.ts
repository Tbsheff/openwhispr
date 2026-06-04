import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
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

interface MeetingRow extends Row {
  id: number;
  title: string;
  meeting_date: string;
  attendees: string | null;
  folder_id: number | null;
  folder_name: string | null;
  workspace_id: string | null;
  team_id: string | null;
  audio_duration_seconds: number | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface MeetingDetailRow extends MeetingRow {
  content: string;
  enhanced_content: string | null;
  transcript: string | null;
  note_type: string;
  score?: number;
  snippet?: string | null;
}

interface MeetingFolderRow extends Row {
  id: number;
  title: string;
  is_default: boolean;
  sort_order: number;
  workspace_id: string | null;
  team_id: string | null;
  note_count: number;
  latest_meeting_at: string | null;
}

interface AccountInfoRow extends Row {
  note_count: number;
  meeting_count: number;
  transcription_count: number;
  folder_count: number;
  memory_count: number;
  latest_meeting_at: string | null;
}

interface AccountInfoContext {
  authInfo?: AuthInfo;
  accessContext: AccessContext;
  githubOrg?: string;
  serverUrl?: string;
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

function meetingPredicate(): string {
  return "(n.note_type = 'meeting' OR lower(coalesce(f.name, '')) = 'meetings')";
}

function noteFolderJoinPredicate(): string {
  return [
    "f.id = n.folder_id",
    "f.workspace_id IS NOT DISTINCT FROM n.workspace_id",
    "f.team_id IS NOT DISTINCT FROM n.team_id",
  ].join("\n      AND ");
}

function whereWithScope(baseFilters: string[], params: DbParam[], scope: ResourceScope, tableAlias?: string): string {
  const filters = [...baseFilters];
  appendScopeFilters(filters, params, scope, tableAlias);
  return filters.join(" AND ");
}

function extraString(authInfo: AuthInfo | undefined, key: string): string | null {
  const value = authInfo?.extra?.[key];
  return typeof value === "string" ? value : null;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function formatMeetingContext(rows: MeetingDetailRow[], maxChars: number): string {
  const lines: string[] = [];
  let total = 0;

  for (const row of rows) {
    const body = row.snippet || row.enhanced_content || row.content || row.transcript || "";
    const line = `[meeting:${row.id}] ${row.title} (${row.meeting_date})\n${truncate(body, 700)}`;
    if (total + line.length + 2 > maxChars) break;
    lines.push(line);
    total += line.length + 2;
  }

  return lines.join("\n\n");
}

async function listMeetingFolders(db: Db, scope: ResourceScope): Promise<MeetingFolderRow[]> {
  const params: DbParam[] = [];
  const noteJoinFilters = [
    "f.id = n.folder_id",
    "f.workspace_id IS NOT DISTINCT FROM n.workspace_id",
    "f.team_id IS NOT DISTINCT FROM n.team_id",
    "n.deleted_at IS NULL",
    "(n.note_type = 'meeting' OR lower(f.name) = 'meetings')",
  ];
  appendScopeFilters(noteJoinFilters, params, scope, "n");
  const folderWhere = whereWithScope([], params, scope, "f");

  return db.getMany<MeetingFolderRow>(`
    SELECT
      f.id,
      f.name AS title,
      f.is_default,
      f.sort_order,
      f.workspace_id,
      f.team_id,
      count(n.id)::int AS note_count,
      max(n.created_at) AS latest_meeting_at
    FROM folders f
    LEFT JOIN notes n
      ON ${noteJoinFilters.join("\n      AND ")}
    ${folderWhere ? `WHERE ${folderWhere}` : ""}
    GROUP BY f.id, f.name, f.is_default, f.sort_order, f.workspace_id, f.team_id
    ORDER BY f.sort_order, f.name
  `, params);
}

async function listMeetings(
  db: Db,
  options: {
    folderId?: number;
    attendee?: string;
    startDate?: string;
    endDate?: string;
    limit: number;
    scope: ResourceScope;
  }
): Promise<MeetingRow[]> {
  const filters = ["n.deleted_at IS NULL", meetingPredicate()];
  const params: DbParam[] = [];
  let i = 1;
  appendScopeFilters(filters, params, options.scope, "n");
  i = params.length + 1;

  if (options.folderId !== undefined) {
    filters.push(`n.folder_id = $${i++}`);
    params.push(options.folderId);
  }
  if (options.attendee) {
    filters.push(`n.participants ILIKE $${i++}`);
    params.push(`%${options.attendee}%`);
  }
  if (options.startDate) {
    filters.push(`n.created_at >= $${i++}`);
    params.push(options.startDate);
  }
  if (options.endDate) {
    filters.push(`n.created_at <= $${i++}`);
    params.push(options.endDate);
  }

  params.push(options.limit);

  return db.getMany<MeetingRow>(`
    SELECT
      n.id,
      n.title,
      n.created_at AS meeting_date,
      n.participants AS attendees,
      n.folder_id,
      f.name AS folder_name,
      n.workspace_id,
      n.team_id,
      n.audio_duration_seconds,
      n.created_by,
      n.created_at,
      n.updated_at
    FROM notes n
    LEFT JOIN folders f ON ${noteFolderJoinPredicate()}
    WHERE ${filters.join(" AND ")}
    ORDER BY n.created_at DESC
    LIMIT $${i}
  `, params);
}

async function getMeetings(
  db: Db,
  options: {
    ids?: number[];
    query?: string;
    folderId?: number;
    limit: number;
    scope: ResourceScope;
  }
): Promise<{ meetings: MeetingDetailRow[]; context: string }> {
  const filters = ["n.deleted_at IS NULL", meetingPredicate()];
  const params: DbParam[] = [];
  let i = 1;
  let scoreSelect = "null::real AS score";
  let snippetSelect = "left(concat_ws(' ', n.enhanced_content, n.content, n.transcript), 700) AS snippet";
  appendScopeFilters(filters, params, options.scope, "n");
  i = params.length + 1;

  if (options.ids && options.ids.length > 0) {
    filters.push(`n.id = ANY($${i++}::int[])`);
    params.push(options.ids.map((id) => String(id)));
  }

  if (options.folderId !== undefined) {
    filters.push(`n.folder_id = $${i++}`);
    params.push(options.folderId);
  }

  if (options.query) {
    params.push(options.query);
    const queryParam = i++;
    const vector = "to_tsvector('english', concat_ws(' ', n.title, n.content, n.enhanced_content, n.transcript, n.participants))";
    filters.push(`${vector} @@ websearch_to_tsquery('english', $${queryParam})`);
    scoreSelect = `ts_rank_cd(${vector}, websearch_to_tsquery('english', $${queryParam})) AS score`;
    snippetSelect = `ts_headline('english', concat_ws(' ', n.enhanced_content, n.content, n.transcript), websearch_to_tsquery('english', $${queryParam}), 'MaxFragments=2, MinWords=8, MaxWords=24') AS snippet`;
  }

  params.push(options.limit);

  const meetings = await db.getMany<MeetingDetailRow>(`
    SELECT
      n.id,
      n.title,
      n.note_type,
      n.content,
      n.enhanced_content,
      n.transcript,
      n.created_at AS meeting_date,
      n.participants AS attendees,
      n.folder_id,
      f.name AS folder_name,
      n.workspace_id,
      n.team_id,
      n.audio_duration_seconds,
      n.created_by,
      n.created_at,
      n.updated_at,
      ${scoreSelect},
      ${snippetSelect}
    FROM notes n
    LEFT JOIN folders f ON ${noteFolderJoinPredicate()}
    WHERE ${filters.join(" AND ")}
    ORDER BY score DESC NULLS LAST, n.created_at DESC
    LIMIT $${i}
  `, params);

  return { meetings, context: formatMeetingContext(meetings, 8000) };
}

async function getMeetingTranscript(db: Db, id: number, scope: ResourceScope) {
  const params: DbParam[] = [id];
  const filters = ["n.id = $1", "n.deleted_at IS NULL", meetingPredicate()];
  appendScopeFilters(filters, params, scope, "n");
  const row = await db.getOne<MeetingDetailRow>(`
    SELECT
      n.id,
      n.title,
      n.note_type,
      n.content,
      n.enhanced_content,
      n.transcript,
      n.created_at AS meeting_date,
      n.participants AS attendees,
      n.folder_id,
      f.name AS folder_name,
      n.workspace_id,
      n.team_id,
      n.audio_duration_seconds,
      n.created_by,
      n.created_at,
      n.updated_at
    FROM notes n
    LEFT JOIN folders f ON ${noteFolderJoinPredicate()}
    WHERE ${filters.join(" AND ")}
  `, params);

  if (!row) return null;
  return {
    meetingId: row.id,
    title: row.title,
    meetingDate: row.meeting_date,
    attendees: row.attendees,
    workspaceId: row.workspace_id,
    teamId: row.team_id,
    transcript: row.transcript ?? "",
  };
}

async function getAccountInfo(db: Db, context: AccountInfoContext, scope: ResourceScope) {
  const params: DbParam[] = [];
  const noteWhere = whereWithScope(["deleted_at IS NULL"], params, scope);
  const meetingWhere = whereWithScope(["n.deleted_at IS NULL", meetingPredicate()], params, scope, "n");
  const transcriptionWhere = whereWithScope(["deleted_at IS NULL"], params, scope);
  const folderWhere = whereWithScope([], params, scope);
  const memoryWhere = whereWithScope(["deleted_at IS NULL"], params, scope);
  const latestMeetingWhere = whereWithScope(["n.deleted_at IS NULL", meetingPredicate()], params, scope, "n");
  const row = await db.getOne<AccountInfoRow>(`
    SELECT
      (SELECT count(*)::int FROM notes WHERE ${noteWhere}) AS note_count,
      (
        SELECT count(*)::int
        FROM notes n
        LEFT JOIN folders f ON ${noteFolderJoinPredicate()}
        WHERE ${meetingWhere}
      ) AS meeting_count,
      (SELECT count(*)::int FROM transcriptions WHERE ${transcriptionWhere}) AS transcription_count,
      (SELECT count(*)::int FROM folders${folderWhere ? ` WHERE ${folderWhere}` : ""}) AS folder_count,
      (SELECT count(*)::int FROM memories WHERE ${memoryWhere}) AS memory_count,
      (
        SELECT max(n.created_at)
        FROM notes n
        LEFT JOIN folders f ON ${noteFolderJoinPredicate()}
        WHERE ${latestMeetingWhere}
      ) AS latest_meeting_at
  `, params);

  return {
    server: "openwhispr",
    version: "1.0.0",
    account: {
      clientId: context.authInfo?.clientId ?? null,
      githubUsername: extraString(context.authInfo, "githubUsername"),
      expiresAt: context.authInfo?.expiresAt ?? null,
      githubOrg: context.githubOrg ?? null,
      serverUrl: context.serverUrl ?? null,
    },
    auth: "github_oauth_org",
    transport: "streamable_http",
    ...(hasResourceScope(scope) ? { scope: scopeResponse(scope) } : {}),
    capabilities: {
      meetingSearch: true,
      transcriptRetrieval: true,
      durableMemory: true,
      writeTools: true,
    },
    stats: row,
  };
}

export function registerMeetingTools(server: McpServer, db: Db, context: AccountInfoContext): void {
  server.tool("query_openwhispr_meetings", "Ask a natural-language question over OpenWhispr meeting notes. Returns matching meetings and a compact context block.", {
    ...resourceScopeSchema,
    query: z.string().min(1),
    folder_id: z.number().int().optional(),
    limit: z.number().int().min(1).max(50).default(10),
  }, async ({ query, folder_id, limit, workspace_id, team_id }) => {
    try {
      const scope = authorizeResourceScope({ workspace_id, team_id }, context.accessContext);
      return jsonContent(await getMeetings(db, { query, folderId: folder_id, limit, scope }));
    } catch (error) {
      return errorContent(errorMessage(error));
    }
  });

  server.tool("list_meeting_folders", "List OpenWhispr folders with meeting counts.", {
    ...resourceScopeSchema,
  }, async ({ workspace_id, team_id }) => {
    try {
      return jsonContent(await listMeetingFolders(db, authorizeResourceScope({ workspace_id, team_id }, context.accessContext)));
    } catch (error) {
      return errorContent(errorMessage(error));
    }
  });

  server.tool("list_meetings", "List OpenWhispr meetings with optional folder, attendee, and date filters. Returns metadata only.", {
    ...resourceScopeSchema,
    folder_id: z.number().int().optional(),
    attendee: z.string().optional(),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(25),
  }, async ({ folder_id, attendee, start_date, end_date, limit, workspace_id, team_id }) => {
    try {
      const scope = authorizeResourceScope({ workspace_id, team_id }, context.accessContext);
      return jsonContent(await listMeetings(db, {
        folderId: folder_id,
        attendee,
        startDate: start_date,
        endDate: end_date,
        limit,
        scope,
      }));
    } catch (error) {
      return errorContent(errorMessage(error));
    }
  });

  server.tool("get_meetings", "Get full OpenWhispr meeting notes by IDs or by content query. Use this for summaries, action items, and decisions.", {
    ...resourceScopeSchema,
    ids: z.array(z.number().int()).optional(),
    query: z.string().optional(),
    folder_id: z.number().int().optional(),
    limit: z.number().int().min(1).max(50).default(10),
  }, async ({ ids, query, folder_id, limit, workspace_id, team_id }) => {
    try {
      const scope = authorizeResourceScope({ workspace_id, team_id }, context.accessContext);
      return jsonContent(await getMeetings(db, { ids, query, folderId: folder_id, limit, scope }));
    } catch (error) {
      return errorContent(errorMessage(error));
    }
  });

  server.tool("get_meeting_transcript", "Get the verbatim transcript for an OpenWhispr meeting note by meeting ID.", {
    ...resourceScopeSchema,
    id: z.number().int().min(1),
  }, async ({ id, workspace_id, team_id }) => {
    try {
      const transcript = await getMeetingTranscript(db, id, authorizeResourceScope({ workspace_id, team_id }, context.accessContext));
      if (!transcript) return { content: [{ type: "text" as const, text: `Meeting ${id} not found.` }], isError: true };
      return jsonContent(transcript);
    } catch (error) {
      return errorContent(errorMessage(error));
    }
  });

  server.tool("get_account_info", "Return OpenWhispr MCP account/server capabilities and corpus counts.", {
    ...resourceScopeSchema,
  }, async ({ workspace_id, team_id }) => {
    try {
      return jsonContent(await getAccountInfo(db, context, authorizeResourceScope({ workspace_id, team_id }, context.accessContext)));
    } catch (error) {
      return errorContent(errorMessage(error));
    }
  });
}
