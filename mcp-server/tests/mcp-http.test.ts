import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/index.js";
import { handleAuthorize, handleGitHubCallback, handleMetadata, handleRegister, handleToken } from "../src/auth.js";
import type { Db, DbParam, QueryResult, Row } from "../src/db.js";
import type { Env } from "../src/auth.js";
import { createTestEnv } from "./test-env.js";

interface JsonRpcResponse {
  result?: unknown;
  error?: unknown;
  jsonrpc: "2.0";
  id: number | null;
}

interface ToolsListResult {
  tools: Array<{ name: string }>;
}

interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface RegisteredClientResponse {
  client_id: string;
  redirect_uris: string[];
}

interface TokenResponseBody {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

interface ObservedDbCall {
  method: "query" | "getOne" | "getMany";
  text: string;
  params: readonly DbParam[];
}

type ObserveDbCall = (call: ObservedDbCall) => void;

function jsonRpc(method: string, id: number, params: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function findDbCall(calls: ObservedDbCall[], label: string, predicate: (call: ObservedDbCall) => boolean): ObservedDbCall {
  const call = calls.find(predicate);
  if (!call) throw new Error(`Missing DB call: ${label}`);
  return call;
}

function expectScopeConsistentFolderJoin(text: string): void {
  expect(text).toContain("f.id = n.folder_id");
  expect(text).toContain("f.workspace_id IS NOT DISTINCT FROM n.workspace_id");
  expect(text).toContain("f.team_id IS NOT DISTINCT FROM n.team_id");
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function createRequest(body: string, token = "valid-token"): Request {
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

function createFormRequest(fields: Record<string, string>): Request {
  const body = new URLSearchParams(fields);
  return new Request("http://localhost/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

function responseLocation(response: Response): URL {
  const location = response.headers.get("location");
  expect(location).toBeTruthy();
  return new URL(location ?? "http://invalid.local");
}

function base64url(bytes: ArrayBuffer): string {
  const raw = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

async function registerClient(env: Env, redirectUri = "https://client.example/callback"): Promise<RegisteredClientResponse> {
  const response = await handleRegister(new Request("http://localhost/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "Test client" }),
  }), env);

  expect(response.status).toBe(201);
  return readJson<RegisteredClientResponse>(response);
}

function stubGitHubOAuth(): ReturnType<typeof vi.fn> {
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

async function issueAuthorizationCode(env: Env, verifier: string, redirectUri = "https://client.example/callback") {
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

function createFakeDb(observe?: ObserveDbCall): Db {
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

function createAuthInfo(token: string): AuthInfo {
  return {
    token,
    clientId: "test-client",
    scopes: [],
    extra: { githubUsername: "test-user" },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MCP HTTP app", () => {
  it("returns health status", async () => {
    const app = createApp();
    const response = await app.request("/health", undefined, createTestEnv());

    await expect(response.json()).resolves.toEqual({ ok: true, version: "1.0.0" });
    expect(response.status).toBe(200);
  });

  it("returns OAuth metadata without advertising unsupported refresh tokens", async () => {
    const response = handleMetadata(createTestEnv({
      SERVER_URL: "http://localhost:8792",
    }));
    const metadata = await readJson<{
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      grant_types_supported: string[];
    }>(response);

    expect(metadata).toMatchObject({
      issuer: "http://localhost:8792",
      authorization_endpoint: "http://localhost:8792/authorize",
      token_endpoint: "http://localhost:8792/token",
    });
    expect(metadata.grant_types_supported).toEqual(["authorization_code"]);
    expect(metadata.grant_types_supported).not.toContain("refresh_token");
    expect(response.status).toBe(200);
  });

  it("rejects dynamic client registration without redirect URIs", async () => {
    const response = await handleRegister(new Request("http://localhost/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "No redirect client" }),
    }), createTestEnv());
    const body = await readJson<{ error: string }>(response);

    expect(response.status).toBe(400);
    expect(body.error).toBe("invalid_client_metadata");
  });

  it("validates OAuth authorize clients, redirects, state, and PKCE before GitHub redirect", async () => {
    const env = createTestEnv();
    const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
    const redirectUri = "https://client.example/callback";
    const client = await registerClient(env, redirectUri);

    const unregistered = await handleAuthorize(new URL(`http://localhost/authorize?response_type=code&client_id=bad-client&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${await pkceChallenge(verifier)}&code_challenge_method=S256&state=client-state`), env);
    await expect(readJson<{ error: string }>(unregistered)).resolves.toMatchObject({ error: "invalid_request" });
    expect(unregistered.status).toBe(400);

    const mismatchedRedirect = await handleAuthorize(new URL(`http://localhost/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent("https://attacker.example/callback")}&code_challenge=${await pkceChallenge(verifier)}&code_challenge_method=S256&state=client-state`), env);
    await expect(readJson<{ error: string }>(mismatchedRedirect)).resolves.toMatchObject({ error: "invalid_request" });
    expect(mismatchedRedirect.status).toBe(400);

    const missingState = await handleAuthorize(new URL(`http://localhost/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${await pkceChallenge(verifier)}&code_challenge_method=S256`), env);
    await expect(readJson<{ error_description: string }>(missingState)).resolves.toMatchObject({ error_description: "state is required" });
    expect(missingState.status).toBe(400);

    const missingPkce = await handleAuthorize(new URL(`http://localhost/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(redirectUri)}&state=client-state`), env);
    await expect(readJson<{ error_description: string }>(missingPkce)).resolves.toMatchObject({ error_description: "S256 PKCE is required" });
    expect(missingPkce.status).toBe(400);

    const valid = await handleAuthorize(new URL(`http://localhost/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${await pkceChallenge(verifier)}&code_challenge_method=S256&state=client-state`), env);
    const githubRedirect = responseLocation(valid);

    expect(valid.status).toBe(302);
    expect(githubRedirect.origin + githubRedirect.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(githubRedirect.searchParams.get("state")).toMatch(/^[a-f0-9]{64}$/);
    expect(githubRedirect.searchParams.get("state")).not.toContain(redirectUri);
  });

  it("rejects forged GitHub callback state before exchanging GitHub code", async () => {
    const fetchMock = stubGitHubOAuth();
    const response = await handleGitHubCallback(new URL("http://localhost/github/callback?code=github-code&state=forged-state"), createTestEnv());

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("Invalid state");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("enforces PKCE, client, and redirect binding before minting access tokens", async () => {
    stubGitHubOAuth();
    const env = createTestEnv();
    const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
    const issued = await issueAuthorizationCode(env, verifier);

    const missingVerifier = await handleToken(createFormRequest({
      grant_type: "authorization_code",
      code: issued.code,
      client_id: issued.client.client_id,
      redirect_uri: issued.redirectUri,
    }), env);
    await expect(readJson<TokenResponseBody>(missingVerifier)).resolves.toMatchObject({ error: "invalid_grant" });
    expect(missingVerifier.status).toBe(400);

    const wrongRedirectIssued = await issueAuthorizationCode(env, verifier);
    const wrongRedirect = await handleToken(createFormRequest({
      grant_type: "authorization_code",
      code: wrongRedirectIssued.code,
      client_id: wrongRedirectIssued.client.client_id,
      redirect_uri: "https://attacker.example/callback",
      code_verifier: verifier,
    }), env);
    await expect(readJson<TokenResponseBody>(wrongRedirect)).resolves.toMatchObject({ error: "invalid_grant" });
    expect(wrongRedirect.status).toBe(400);

    const wrongVerifierIssued = await issueAuthorizationCode(env, verifier);
    const wrongVerifier = await handleToken(createFormRequest({
      grant_type: "authorization_code",
      code: wrongVerifierIssued.code,
      client_id: wrongVerifierIssued.client.client_id,
      redirect_uri: wrongVerifierIssued.redirectUri,
      code_verifier: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq",
    }), env);
    await expect(readJson<TokenResponseBody>(wrongVerifier)).resolves.toMatchObject({ error: "invalid_grant" });
    expect(wrongVerifier.status).toBe(400);

    const validIssued = await issueAuthorizationCode(env, verifier);
    const valid = await handleToken(createFormRequest({
      grant_type: "authorization_code",
      code: validIssued.code,
      client_id: validIssued.client.client_id,
      redirect_uri: validIssued.redirectUri,
      code_verifier: verifier,
    }), env);
    const token = await readJson<TokenResponseBody>(valid);

    expect(valid.status).toBe(200);
    expect(token.access_token).toBeTruthy();
    expect(token.token_type).toBe("Bearer");
    expect(token.expires_in).toBe(86400);
    expect(token.refresh_token).toBeUndefined();
  });

  it("rejects missing auth without creating a DB", async () => {
    const createDb = vi.fn(() => createFakeDb());
    const verifyAccessToken = vi.fn(async (token: string) => createAuthInfo(token));
    const app = createApp({ createDb, verifyAccessToken });

    const response = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: jsonRpc("initialize", 1),
    }, createTestEnv());

    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(response.status).toBe(401);
    expect(createDb).not.toHaveBeenCalled();
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });

  it("rejects invalid bearer tokens without creating a DB", async () => {
    const createDb = vi.fn(() => createFakeDb());
    const verifyAccessToken = vi.fn(async () => {
      throw new Error("bad token");
    });
    const app = createApp({ createDb, verifyAccessToken });

    const response = await app.fetch(createRequest(jsonRpc("initialize", 1)), createTestEnv());

    await expect(response.json()).resolves.toEqual({ error: "invalid_token" });
    expect(response.status).toBe(401);
    expect(createDb).not.toHaveBeenCalled();
    expect(verifyAccessToken).toHaveBeenCalledOnce();
  });

  it("lists registered MCP tools through the HTTP transport", async () => {
    const app = createApp({
      createDb: vi.fn(() => createFakeDb()),
      verifyAccessToken: vi.fn(async (token: string) => createAuthInfo(token)),
    });

    const response = await app.fetch(createRequest(jsonRpc("tools/list", 2)), createTestEnv());
    const body = await readJson<JsonRpcResponse>(response);
    const result = body.result as ToolsListResult;

    expect(response.status).toBe(200);
    expect(result.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "list_notes",
      "get_note",
      "search_notes",
      "create_note",
      "update_note",
      "delete_note",
      "list_transcriptions",
      "get_transcription",
      "create_transcription",
      "list_folders",
      "create_folder",
      "remember_memory",
      "search_memories",
      "get_memory",
      "update_memory",
      "delete_memory",
      "memory_query",
      "memory_stats",
      "memory_status",
      "query_openwhispr_meetings",
      "list_meeting_folders",
      "list_meetings",
      "get_meetings",
      "get_meeting_transcript",
      "get_account_info",
    ]));
  });

  it("validates create_note folder IDs against the new note scope", async () => {
    const calls: ObservedDbCall[] = [];
    const app = createApp({
      createDb: vi.fn(() => createFakeDb((call) => calls.push(call))),
      verifyAccessToken: vi.fn(async (token: string) => createAuthInfo(token)),
    });

    const response = await app.fetch(createRequest(jsonRpc("tools/call", 13, {
      name: "create_note",
      arguments: {
        title: "Scoped note",
        content: "Scoped body",
        folder_id: 2,
        workspace_id: "workspace-alpha",
        team_id: "team-blue",
      },
    })), createTestEnv());
    const body = await readJson<JsonRpcResponse>(response);
    const result = body.result as ToolCallResult;
    const created = JSON.parse(result.content[0]?.text ?? "{}") as {
      folder_id: number;
      workspace_id: string;
      team_id: string;
    };
    const validationCall = findDbCall(calls, "create_note folder scope validation", (call) => (
      call.method === "getOne" && call.text.includes("SELECT id FROM folders WHERE id = $1")
    ));
    const insertCall = findDbCall(calls, "create_note insert", (call) => (
      call.method === "getOne" && call.text.includes("INSERT INTO notes")
    ));

    expect(response.status).toBe(200);
    expect(result.isError).not.toBe(true);
    expect(created).toEqual(expect.objectContaining({
      folder_id: 2,
      workspace_id: "workspace-alpha",
      team_id: "team-blue",
    }));
    expect(validationCall.text).toContain("workspace_id IS NOT DISTINCT FROM $2");
    expect(validationCall.text).toContain("team_id IS NOT DISTINCT FROM $3");
    expect(validationCall.params).toEqual([2, "workspace-alpha", "team-blue"]);
    expect(insertCall.params).toEqual(["Scoped note", "Scoped body", "personal", 2, null, "workspace-alpha", "team-blue"]);
  });

  it("validates update_note folder IDs against the existing note scope", async () => {
    const calls: ObservedDbCall[] = [];
    const app = createApp({
      createDb: vi.fn(() => createFakeDb((call) => calls.push(call))),
      verifyAccessToken: vi.fn(async (token: string) => createAuthInfo(token)),
    });

    const response = await app.fetch(createRequest(jsonRpc("tools/call", 14, {
      name: "update_note",
      arguments: {
        id: 30,
        folder_id: 2,
      },
    })), createTestEnv());
    const body = await readJson<JsonRpcResponse>(response);
    const result = body.result as ToolCallResult;
    const updated = JSON.parse(result.content[0]?.text ?? "{}") as {
      folder_id: number;
      workspace_id: string;
      team_id: string;
    };
    const noteScopeCall = findDbCall(calls, "update_note existing note scope lookup", (call) => (
      call.method === "getOne" && call.text.includes("SELECT workspace_id, team_id FROM notes WHERE")
    ));
    const validationCall = findDbCall(calls, "update_note folder scope validation", (call) => (
      call.method === "getOne" && call.text.includes("SELECT id FROM folders WHERE id = $1")
    ));
    const updateCall = findDbCall(calls, "update_note update", (call) => (
      call.method === "getOne" && call.text.includes("UPDATE notes SET")
    ));

    expect(response.status).toBe(200);
    expect(result.isError).not.toBe(true);
    expect(updated).toEqual(expect.objectContaining({
      folder_id: 2,
      workspace_id: "workspace-alpha",
      team_id: "team-blue",
    }));
    expect(noteScopeCall.params).toEqual([30]);
    expect(validationCall.text).toContain("workspace_id IS NOT DISTINCT FROM $2");
    expect(validationCall.text).toContain("team_id IS NOT DISTINCT FROM $3");
    expect(validationCall.params).toEqual([2, "workspace-alpha", "team-blue"]);
    expect(updateCall.text).toContain("folder_id = $1");
    expect(updateCall.params).toEqual([2, 30]);
  });

  it("keeps note writes unchanged when folder_id is omitted", async () => {
    const calls: ObservedDbCall[] = [];
    const app = createApp({
      createDb: vi.fn(() => createFakeDb((call) => calls.push(call))),
      verifyAccessToken: vi.fn(async (token: string) => createAuthInfo(token)),
    });

    const createResponse = await app.fetch(createRequest(jsonRpc("tools/call", 15, {
      name: "create_note",
      arguments: {
        title: "Unfoldered note",
        content: "No folder change",
        workspace_id: "workspace-alpha",
        team_id: "team-blue",
      },
    })), createTestEnv());
    const updateResponse = await app.fetch(createRequest(jsonRpc("tools/call", 16, {
      name: "update_note",
      arguments: {
        id: 30,
        title: "Retitled note",
      },
    })), createTestEnv());
    const validationCalls = calls.filter((call) => (
      call.method === "getOne" && (
        call.text.includes("SELECT id FROM folders WHERE id = $1")
        || call.text.includes("SELECT workspace_id, team_id FROM notes WHERE")
      )
    ));

    expect(createResponse.status).toBe(200);
    expect(updateResponse.status).toBe(200);
    expect(validationCalls).toEqual([]);
  });

  it("uses scope-consistent folder joins for meeting and memory note queries", async () => {
    const calls: ObservedDbCall[] = [];
    const app = createApp({
      createDb: vi.fn(() => createFakeDb((call) => calls.push(call))),
      verifyAccessToken: vi.fn(async (token: string) => createAuthInfo(token)),
    });

    const meetingResponse = await app.fetch(createRequest(jsonRpc("tools/call", 15, {
      name: "query_openwhispr_meetings",
      arguments: { query: "morning scheduling" },
    })), createTestEnv());
    const memoryResponse = await app.fetch(createRequest(jsonRpc("tools/call", 16, {
      name: "memory_query",
      arguments: {
        query: "morning scheduling",
        include_memories: false,
        include_transcriptions: false,
      },
    })), createTestEnv());
    const meetingCall = findDbCall(calls, "meeting note-folder join", (call) => (
      call.method === "getMany" && call.text.includes("FROM notes n") && call.text.includes("ORDER BY score DESC")
    ));
    const memoryCall = findDbCall(calls, "memory note-folder join", (call) => (
      call.method === "getMany" && call.text.includes("corpus_items")
    ));

    expect(meetingResponse.status).toBe(200);
    expect(memoryResponse.status).toBe(200);
    expectScopeConsistentFolderJoin(meetingCall.text);
    expectScopeConsistentFolderJoin(memoryCall.text);
  });

  it("calls list_folders through the HTTP transport", async () => {
    const app = createApp({
      createDb: vi.fn(() => createFakeDb()),
      verifyAccessToken: vi.fn(async (token: string) => createAuthInfo(token)),
    });

    const response = await app.fetch(createRequest(jsonRpc("tools/call", 3, {
      name: "list_folders",
      arguments: {},
    })), createTestEnv());
    const body = await readJson<JsonRpcResponse>(response);
    const result = body.result as ToolCallResult;
    const folders = JSON.parse(result.content[0]?.text ?? "[]") as Array<{ name: string }>;

    expect(response.status).toBe(200);
    expect(result.isError).not.toBe(true);
    expect(folders.map((folder) => folder.name)).toEqual(["Personal", "Meetings"]);
  });

  it("lists meeting folders and meetings through the HTTP transport", async () => {
    const app = createApp({
      createDb: vi.fn(() => createFakeDb()),
      verifyAccessToken: vi.fn(async (token: string) => createAuthInfo(token)),
    });

    const folderResponse = await app.fetch(createRequest(jsonRpc("tools/call", 4, {
      name: "list_meeting_folders",
      arguments: {},
    })), createTestEnv());
    const folderBody = await readJson<JsonRpcResponse>(folderResponse);
    const folders = JSON.parse((folderBody.result as ToolCallResult).content[0]?.text ?? "[]") as Array<{ title: string; note_count: number }>;

    expect(folderResponse.status).toBe(200);
    expect(folders).toEqual([{ id: 2, title: "Meetings", is_default: true, sort_order: 1, note_count: 1, latest_meeting_at: "2026-05-31T01:00:00.000Z" }]);

    const meetingResponse = await app.fetch(createRequest(jsonRpc("tools/call", 5, {
      name: "list_meetings",
      arguments: { folder_id: 2 },
    })), createTestEnv());
    const meetingBody = await readJson<JsonRpcResponse>(meetingResponse);
    const meetings = JSON.parse((meetingBody.result as ToolCallResult).content[0]?.text ?? "[]") as Array<{ title: string; folder_name: string }>;

    expect(meetingResponse.status).toBe(200);
    expect(meetings).toEqual([expect.objectContaining({ title: "Care sync", folder_name: "Meetings" })]);
  });

  it("queries meeting notes and returns meeting context", async () => {
    const app = createApp({
      createDb: vi.fn(() => createFakeDb()),
      verifyAccessToken: vi.fn(async (token: string) => createAuthInfo(token)),
    });

    const response = await app.fetch(createRequest(jsonRpc("tools/call", 6, {
      name: "query_openwhispr_meetings",
      arguments: { query: "morning scheduling", folder_id: 2 },
    })), createTestEnv());
    const body = await readJson<JsonRpcResponse>(response);
    const result = JSON.parse((body.result as ToolCallResult).content[0]?.text ?? "{}") as { meetings: Array<{ title: string }>; context: string };

    expect(response.status).toBe(200);
    expect(result.meetings[0]?.title).toBe("Care sync");
    expect(result.context).toContain("[meeting:20]");
    expect(result.context).toContain("Care sync");
  });

  it("returns meeting transcripts through the HTTP transport", async () => {
    const app = createApp({
      createDb: vi.fn(() => createFakeDb()),
      verifyAccessToken: vi.fn(async (token: string) => createAuthInfo(token)),
    });

    const response = await app.fetch(createRequest(jsonRpc("tools/call", 7, {
      name: "get_meeting_transcript",
      arguments: { id: 20 },
    })), createTestEnv());
    const body = await readJson<JsonRpcResponse>(response);
    const transcript = JSON.parse((body.result as ToolCallResult).content[0]?.text ?? "{}") as { meetingId: number; transcript: string };

    expect(response.status).toBe(200);
    expect(transcript.meetingId).toBe(20);
    expect(transcript.transcript).toContain("morning scheduling");
  });

  it("returns account info through the HTTP transport", async () => {
    const app = createApp({
      createDb: vi.fn(() => createFakeDb()),
      verifyAccessToken: vi.fn(async (token: string) => ({
        ...createAuthInfo(token),
        expiresAt: 1780272000,
      })),
    });

    const response = await app.fetch(createRequest(jsonRpc("tools/call", 8, {
      name: "get_account_info",
      arguments: {},
    })), createTestEnv({
      GITHUB_ORG: "openwhispr",
      SERVER_URL: "https://mcp.openwhispr.test",
    }));
    const body = await readJson<JsonRpcResponse>(response);
    const accountInfo = JSON.parse((body.result as ToolCallResult).content[0]?.text ?? "{}") as {
      account: { clientId: string; githubUsername: string; githubOrg: string; serverUrl: string };
      stats: { meeting_count: number };
    };

    expect(response.status).toBe(200);
    expect(accountInfo.account).toEqual(expect.objectContaining({
      clientId: "test-client",
      githubUsername: "test-user",
      githubOrg: "openwhispr",
      serverUrl: "https://mcp.openwhispr.test",
    }));
    expect(accountInfo.stats.meeting_count).toBe(1);
  });

  it("creates and searches durable memories through the HTTP transport", async () => {
    const app = createApp({
      createDb: vi.fn(() => createFakeDb()),
      verifyAccessToken: vi.fn(async (token: string) => createAuthInfo(token)),
    });

    const createResponse = await app.fetch(createRequest(jsonRpc("tools/call", 4, {
      name: "remember_memory",
      arguments: {
        content: "Patients prefer morning scheduling calls.",
        kind: "preference",
        tags: ["scheduling"],
        source_type: "agent",
      },
    })), createTestEnv());
    const createBody = await readJson<JsonRpcResponse>(createResponse);
    const created = JSON.parse((createBody.result as ToolCallResult).content[0]?.text ?? "{}") as { title: string; kind: string };

    expect(createResponse.status).toBe(200);
    expect(created.title).toBe("Scheduling preference");
    expect(created.kind).toBe("preference");

    const searchResponse = await app.fetch(createRequest(jsonRpc("tools/call", 5, {
      name: "search_memories",
      arguments: { query: "morning scheduling", kind: "preference", tags: ["scheduling"] },
    })), createTestEnv());
    const searchBody = await readJson<JsonRpcResponse>(searchResponse);
    const memories = JSON.parse((searchBody.result as ToolCallResult).content[0]?.text ?? "[]") as Array<{ title: string }>;

    expect(searchResponse.status).toBe(200);
    expect(memories.map((memory) => memory.title)).toEqual(["Scheduling preference"]);
  });

  it("queries memory corpus and returns formatted context", async () => {
    const app = createApp({
      createDb: vi.fn(() => createFakeDb()),
      verifyAccessToken: vi.fn(async (token: string) => createAuthInfo(token)),
    });

    const response = await app.fetch(createRequest(jsonRpc("tools/call", 6, {
      name: "memory_query",
      arguments: { query: "morning scheduling", include_notes: false, include_transcriptions: false },
    })), createTestEnv());
    const body = await readJson<JsonRpcResponse>(response);
    const result = JSON.parse((body.result as ToolCallResult).content[0]?.text ?? "{}") as { hits: Array<{ source: string }>; context: string };

    expect(response.status).toBe(200);
    expect(result.hits[0]?.source).toBe("memory");
    expect(result.context).toContain("[memory:10]");
    expect(result.context).toContain("Scheduling preference");
  });

  it("applies workspace and team SQL filters to scoped memory corpus queries", async () => {
    const calls: ObservedDbCall[] = [];
    const app = createApp({
      createDb: vi.fn(() => createFakeDb((call) => calls.push(call))),
      verifyAccessToken: vi.fn(async (token: string) => createAuthInfo(token)),
    });

    const response = await app.fetch(createRequest(jsonRpc("tools/call", 11, {
      name: "memory_query",
      arguments: {
        query: "morning scheduling",
        workspace_id: "workspace-alpha",
        team_id: "team-blue",
      },
    })), createTestEnv());
    const body = await readJson<JsonRpcResponse>(response);
    const result = JSON.parse((body.result as ToolCallResult).content[0]?.text ?? "{}") as {
      filters: { workspaceId: string; teamId: string };
    };
    const corpusCall = findDbCall(calls, "scoped memory_query corpus search", (call) => (
      call.method === "getMany" && call.text.includes("corpus_items")
    ));

    expect(response.status).toBe(200);
    expect(result.filters).toEqual(expect.objectContaining({
      workspaceId: "workspace-alpha",
      teamId: "team-blue",
    }));
    expect(corpusCall.text).toContain("m.workspace_id = $3");
    expect(corpusCall.text).toContain("m.team_id = $4");
    expect(corpusCall.text).toContain("n.workspace_id = $5");
    expect(corpusCall.text).toContain("n.team_id = $6");
    expect(corpusCall.text).toContain("t.workspace_id = $7");
    expect(corpusCall.text).toContain("t.team_id = $8");
    expect(corpusCall.params).toEqual([
      "morning scheduling",
      10,
      "workspace-alpha",
      "team-blue",
      "workspace-alpha",
      "team-blue",
      "workspace-alpha",
      "team-blue",
    ]);
  });

  it("omits workspace and team SQL filters from unscoped memory corpus queries", async () => {
    const calls: ObservedDbCall[] = [];
    const app = createApp({
      createDb: vi.fn(() => createFakeDb((call) => calls.push(call))),
      verifyAccessToken: vi.fn(async (token: string) => createAuthInfo(token)),
    });

    const response = await app.fetch(createRequest(jsonRpc("tools/call", 12, {
      name: "memory_query",
      arguments: { query: "morning scheduling" },
    })), createTestEnv());
    const body = await readJson<JsonRpcResponse>(response);
    const result = JSON.parse((body.result as ToolCallResult).content[0]?.text ?? "{}") as {
      filters: Record<string, unknown>;
    };
    const corpusCall = findDbCall(calls, "unscoped memory_query corpus search", (call) => (
      call.method === "getMany" && call.text.includes("corpus_items")
    ));

    expect(response.status).toBe(200);
    expect(result.filters).not.toHaveProperty("workspaceId");
    expect(result.filters).not.toHaveProperty("teamId");
    expect(corpusCall.text).not.toContain("workspace_id =");
    expect(corpusCall.text).not.toContain("team_id =");
    expect(corpusCall.params).toEqual(["morning scheduling", 10]);
  });

  it("supports folder-scoped memory corpus queries for note hits", async () => {
    const app = createApp({
      createDb: vi.fn(() => createFakeDb()),
      verifyAccessToken: vi.fn(async (token: string) => createAuthInfo(token)),
    });

    const response = await app.fetch(createRequest(jsonRpc("tools/call", 9, {
      name: "memory_query",
      arguments: { query: "morning scheduling", folder_id: 2 },
    })), createTestEnv());
    const body = await readJson<JsonRpcResponse>(response);
    const result = JSON.parse((body.result as ToolCallResult).content[0]?.text ?? "{}") as {
      filters: { folderId: number; folderFilterAppliedTo: string[]; unscopedSources: string[] };
    };

    expect(response.status).toBe(200);
    expect(result.filters).toEqual({
      folderId: 2,
      folderFilterAppliedTo: ["note"],
      unscopedSources: ["memory", "transcription"],
    });
  });

  it("does not bind folder IDs when folder-scoped memory corpus queries exclude notes", async () => {
    const app = createApp({
      createDb: vi.fn(() => createFakeDb()),
      verifyAccessToken: vi.fn(async (token: string) => createAuthInfo(token)),
    });

    const response = await app.fetch(createRequest(jsonRpc("tools/call", 10, {
      name: "memory_query",
      arguments: {
        query: "morning scheduling",
        folder_id: 2,
        include_notes: false,
        include_transcriptions: false,
      },
    })), createTestEnv());
    const body = await readJson<JsonRpcResponse>(response);
    const result = JSON.parse((body.result as ToolCallResult).content[0]?.text ?? "{}") as {
      hits: Array<{ source: string }>;
      filters: { folderId: number; folderFilterAppliedTo: string[]; unscopedSources: string[] };
    };

    expect(response.status).toBe(200);
    expect(result.hits[0]?.source).toBe("memory");
    expect(result.filters).toEqual({
      folderId: 2,
      folderFilterAppliedTo: [],
      unscopedSources: ["memory"],
    });
  });

  it("returns memory status through the HTTP transport", async () => {
    const app = createApp({
      createDb: vi.fn(() => createFakeDb()),
      verifyAccessToken: vi.fn(async (token: string) => createAuthInfo(token)),
    });

    const response = await app.fetch(createRequest(jsonRpc("tools/call", 7, {
      name: "memory_status",
      arguments: {},
    })), createTestEnv());
    const body = await readJson<JsonRpcResponse>(response);
    const result = JSON.parse((body.result as ToolCallResult).content[0]?.text ?? "{}") as { healthy: boolean; stats: { memory_count: number } };

    expect(response.status).toBe(200);
    expect(result.healthy).toBe(true);
    expect(result.stats.memory_count).toBe(1);
  });
});
