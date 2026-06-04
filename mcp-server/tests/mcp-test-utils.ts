import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { expect, vi } from "vitest";
import {
  handleAuthorize,
  handleGitHubCallback,
  handleRegister,
  type Env,
} from "../src/auth.js";
import type { Db, DbParam, QueryResult, Row } from "../src/db.js";

export interface JsonRpcResponse {
  result?: unknown;
  error?: unknown;
  jsonrpc: "2.0";
  id: number | null;
}

export interface ToolsListResult {
  tools: Array<{ name: string }>;
}

export interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface RegisteredClientResponse {
  client_id: string;
  redirect_uris: string[];
}

export interface TokenResponseBody {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

export interface ObservedDbCall {
  method: "query" | "getOne" | "getMany";
  text: string;
  params: readonly DbParam[];
}

type ObserveDbCall = (call: ObservedDbCall) => void;

export function jsonRpc(method: string, id: number, params: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

export function findDbCall(calls: ObservedDbCall[], label: string, predicate: (call: ObservedDbCall) => boolean): ObservedDbCall {
  const call = calls.find(predicate);
  if (!call) throw new Error(`Missing DB call: ${label}`);
  return call;
}

export function expectScopeConsistentFolderJoin(text: string): void {
  expect(text).toContain("f.id = n.folder_id");
  expect(text).toContain("f.workspace_id IS NOT DISTINCT FROM n.workspace_id");
  expect(text).toContain("f.team_id IS NOT DISTINCT FROM n.team_id");
}

export async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export function createRequest(body: string, token = "valid-token"): Request {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body,
  });
}

export function createFormRequest(fields: Record<string, string>): Request {
  const body = new URLSearchParams(fields);
  return new Request("http://localhost/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

export function responseLocation(response: Response): URL {
  const location = response.headers.get("location");
  expect(location).toBeTruthy();
  return new URL(location ?? "http://invalid.local");
}

function base64url(bytes: ArrayBuffer): string {
  const raw = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

export async function registerClient(env: Env, redirectUri = "https://client.example/callback"): Promise<RegisteredClientResponse> {
  const response = await handleRegister(new Request("http://localhost/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "Test client" }),
  }), env);

  expect(response.status).toBe(201);
  return readJson<RegisteredClientResponse>(response);
}

export function stubGitHubOAuth(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "github-token" });
    }
    if (url === "https://api.github.com/user") {
      return Response.json({ login: "test-user", id: 123 });
    }
    if (url === "https://api.github.com/user/orgs") {
      return Response.json([{ login: "openwhispr" }]);
    }
    return new Response("unexpected fetch", { status: 500 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export async function issueAuthorizationCode(env: Env, verifier: string, redirectUri = "https://client.example/callback") {
  const client = await registerClient(env, redirectUri);
  const authorizeResponse = await handleAuthorize(new URL(`http://localhost/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${await pkceChallenge(verifier)}&code_challenge_method=S256&state=client-state`), env);
  const githubRedirect = responseLocation(authorizeResponse);
  const callbackState = githubRedirect.searchParams.get("state");
  expect(callbackState).toBeTruthy();

  const callbackResponse = await handleGitHubCallback(new URL(`http://localhost/github/callback?code=github-code&state=${callbackState}`), env);
  const clientRedirect = responseLocation(callbackResponse);
  const code = clientRedirect.searchParams.get("code");
  expect(clientRedirect.origin + clientRedirect.pathname).toBe(redirectUri);
  expect(clientRedirect.searchParams.get("state")).toBe("client-state");
  expect(code).toBeTruthy();

  return { client, code: code ?? "", redirectUri };
}

export function createFakeDb(observe?: ObserveDbCall): Db {
  const folderRows: Row[] = [
    { id: 1, name: "Personal", is_default: true, sort_order: 0, created_at: "2026-05-31T00:00:00.000Z" },
    { id: 2, name: "Meetings", is_default: true, sort_order: 1, created_at: "2026-05-31T00:00:00.000Z" },
  ];
  const memoryRow = {
    id: 10,
    title: "Scheduling preference",
    content: "Patients prefer morning scheduling calls.",
    kind: "preference",
    tags: ["scheduling"],
    source_type: "agent",
    source_id: "smoke",
    created_by: "test-user",
    created_at: "2026-05-31T00:00:00.000Z",
    updated_at: "2026-05-31T00:00:00.000Z",
    score: 0.42,
    snippet: "Patients prefer <b>morning</b> scheduling calls.",
  };
  const meetingRow = {
    id: 20,
    title: "Care sync",
    note_type: "meeting",
    content: "Discussed morning scheduling and referral follow-up.",
    enhanced_content: "Action item: call patients in the morning.",
    transcript: "Tyler: Patients prefer morning scheduling calls.",
    meeting_date: "2026-05-31T01:00:00.000Z",
    attendees: "Tyler, Enzo",
    folder_id: 2,
    folder_name: "Meetings",
    audio_duration_seconds: 1800,
    created_by: "test-user",
    created_at: "2026-05-31T01:00:00.000Z",
    updated_at: "2026-05-31T02:00:00.000Z",
    score: 0.7,
    snippet: "Patients prefer <b>morning</b> scheduling calls.",
  };
  const noteRow = {
    id: 30,
    title: "Scoped note",
    note_type: "personal",
    folder_id: 2,
    workspace_id: "workspace-alpha",
    team_id: "team-blue",
    created_by: "test-user",
    created_at: "2026-05-31T03:00:00.000Z",
    updated_at: "2026-05-31T03:00:00.000Z",
  };

  return {
    async query<T extends Row = Row>(text: string, params: readonly DbParam[] = []): Promise<QueryResult<T>> {
      observe?.({ method: "query", text, params });
      if (!text.includes("UPDATE notes SET deleted_at") && !text.includes("UPDATE memories SET deleted_at")) {
        throw new Error(`Unexpected query: ${text}`);
      }
      return { rows: [], rowCount: 1 };
    },

    async getOne<T extends Row = Row>(text: string, params: readonly DbParam[] = []): Promise<T | null> {
      observe?.({ method: "getOne", text, params });
      if (text.includes("INSERT INTO memories")) {
        return memoryRow as unknown as T;
      }
      if (text.includes("SELECT id FROM folders WHERE id = $1")) {
        return { id: typeof params[0] === "number" ? params[0] : 2 } as unknown as T;
      }
      if (text.includes("SELECT workspace_id, team_id FROM notes WHERE")) {
        return { workspace_id: noteRow.workspace_id, team_id: noteRow.team_id } as unknown as T;
      }
      if (text.includes("INSERT INTO notes")) {
        return {
          ...noteRow,
          title: typeof params[0] === "string" ? params[0] : noteRow.title,
          note_type: typeof params[2] === "string" ? params[2] : noteRow.note_type,
          folder_id: typeof params[3] === "number" ? params[3] : null,
          created_by: typeof params[4] === "string" ? params[4] : null,
          workspace_id: typeof params[5] === "string" ? params[5] : null,
          team_id: typeof params[6] === "string" ? params[6] : null,
        } as unknown as T;
      }
      if (text.includes("FROM notes n") && text.includes("WHERE n.id = $1")) {
        return meetingRow as unknown as T;
      }
      if (text.includes("FROM memories") && text.includes("WHERE id = $1")) {
        return memoryRow as unknown as T;
      }
      if (text.includes("UPDATE notes SET")) {
        return {
          ...noteRow,
          folder_id: text.includes("folder_id = $1") && typeof params[0] === "number" ? params[0] : noteRow.folder_id,
        } as unknown as T;
      }
      if (text.includes("UPDATE memories")) {
        return { ...memoryRow, title: "Updated scheduling preference" } as unknown as T;
      }
      if (text.includes("SELECT 1::int AS ok")) {
        return { ok: 1 } as unknown as T;
      }
      if (text.includes("memory_count")) {
        return {
          memory_count: 1,
          note_count: 2,
          meeting_count: 1,
          transcription_count: 1,
          folder_count: 2,
          deleted_memory_count: 0,
          deleted_note_count: 0,
          deleted_transcription_count: 0,
          latest_memory_at: "2026-05-31T00:00:00.000Z",
          latest_note_at: "2026-05-31T00:00:00.000Z",
          latest_transcription_at: "2026-05-31T00:00:00.000Z",
        } as unknown as T;
      }
      return null;
    },

    async getMany<T extends Row = Row>(text: string, params: readonly DbParam[] = []): Promise<T[]> {
      observe?.({ method: "getMany", text, params });
      if (text.includes("count(n.id)::int AS note_count")) {
        return [{
          id: 2,
          title: "Meetings",
          is_default: true,
          sort_order: 1,
          note_count: 1,
          latest_meeting_at: meetingRow.created_at,
        }] as unknown as T[];
      }
      if (text.includes("FROM notes WHERE")) {
        return [meetingRow] as unknown as T[];
      }
      if (text.includes("FROM folders")) {
        expect(text).toContain("ORDER BY sort_order");
        return folderRows.map((row) => ({ ...row })) as T[];
      }
      if (text.includes("corpus_items")) {
        expect(text).toContain("websearch_to_tsquery");
        const hasNoteSubquery = text.includes("FROM notes n");
        if ((params?.length ?? 0) === 3) {
          expect(hasNoteSubquery).toBe(true);
          expect(text).toContain("n.folder_id = $3");
        }
        if (!hasNoteSubquery) {
          expect(params).toHaveLength(2);
          expect(text).not.toContain("n.folder_id");
        }
        return [{
          source: "memory",
          id: memoryRow.id,
          title: memoryRow.title,
          note_type: null,
          kind: memoryRow.kind,
          tags: memoryRow.tags,
          folder_id: null,
          folder_name: null,
          created_by: memoryRow.created_by,
          created_at: memoryRow.created_at,
          updated_at: memoryRow.updated_at,
          score: memoryRow.score,
          snippet: memoryRow.snippet,
          preview: memoryRow.content,
        }] as unknown as T[];
      }
      if (text.includes("FROM notes n") && text.includes("AS score")) {
        if (params?.includes(2)) {
          expect(text).toContain("n.folder_id");
        }
        return [meetingRow] as unknown as T[];
      }
      if (text.includes("FROM notes n") && text.includes("ORDER BY n.created_at DESC")) {
        return [meetingRow] as unknown as T[];
      }
      if (text.includes("FROM memories") && text.includes("search_vector @@")) {
        expect(text).toContain("plainto_tsquery");
        return [memoryRow] as unknown as T[];
      }
      throw new Error(`Unexpected getMany: ${text}`);
    },
  };
}

export function createAuthInfo(token: string, extra: Record<string, unknown> = {}): AuthInfo {
  return {
    token,
    clientId: "test-client",
    scopes: [],
    extra: { githubUsername: "test-user", ...extra },
  };
}

export function createScopedAuthInfo(token: string): AuthInfo {
  return createAuthInfo(token, {
    workspaceIds: ["workspace-alpha"],
    teamIdsByWorkspace: { "workspace-alpha": ["team-blue"] },
  });
}
