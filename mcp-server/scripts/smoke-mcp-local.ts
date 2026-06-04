import { createApp } from "../src/index.js";
import { createNodeDb } from "../src/db.node.js";
import { signJwt, type AuthStore, type Env } from "../src/auth.js";

function readDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  return value;
}

const databaseUrl = readDatabaseUrl();
const serverUrl = process.env.SERVER_URL ?? "http://localhost:8787";
const jwtSecret = process.env.JWT_SECRET ?? "local-smoke-secret";

const authStore: AuthStore = {
  async get(): Promise<string | null> {
    return null;
  },
  async put(): Promise<void> {},
  async delete(): Promise<void> {},
};

function createEnv(): Env {
  return {
    DATABASE_URL: databaseUrl,
    SERVER_URL: serverUrl,
    JWT_SECRET: jwtSecret,
    GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID ?? "local-client",
    GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET ?? "local-secret",
    GITHUB_ORG: process.env.GITHUB_ORG ?? "local-org",
    AUTH_KV: authStore,
  };
}

async function postMcp(token: string, body: Record<string, unknown>): Promise<Response> {
  const app = createApp({
    createDb: createNodeDb,
    verifyAccessToken: async (accessToken) => ({
      token: accessToken,
      clientId: "local-smoke",
      scopes: [],
      extra: { githubUsername: "local-smoke" },
    }),
  });

  return app.fetch(new Request(`${serverUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  }), createEnv());
}

async function callTool(token: string, id: number, name: string, args: Record<string, unknown>): Promise<{ content?: Array<{ text?: string }>; isError?: boolean }> {
  const response = await postMcp(token, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const body = await response.json() as { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown };

  if (!response.ok || body.error || body.result?.isError) {
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }

  return body.result ?? {};
}

async function main(): Promise<void> {
  const token = await signJwt({ sub: "local-smoke", clientId: "local-smoke" }, jwtSecret, 300);
  const foldersResult = await callTool(token, 1, "list_folders", {});
  const folders = JSON.parse(foldersResult.content?.[0]?.text ?? "[]") as Array<{ id: number; name: string }>;
  const meetingsFolder = folders.find((folder) => folder.name === "Meetings");

  const memoryPhrase = `local smoke memory ${Date.now()}`;
  await callTool(token, 2, "remember_memory", {
    content: `Remember that ${memoryPhrase} prefers morning scheduling calls.`,
    kind: "preference",
    tags: ["smoke", "scheduling"],
    created_by: "local-smoke",
  });
  const memoryQueryResult = await callTool(token, 3, "memory_query", {
    query: memoryPhrase,
    include_notes: false,
    include_transcriptions: false,
  });
  const memoryQuery = JSON.parse(memoryQueryResult.content?.[0]?.text ?? "{}") as { hits?: unknown[] };
  const meetingPhrase = `local smoke meeting ${Date.now()}`;
  await callTool(token, 4, "create_note", {
    title: "Local smoke meeting",
    content: `Discussed ${meetingPhrase} and morning scheduling follow-up.`,
    note_type: "meeting",
    folder_id: meetingsFolder?.id,
    created_by: "local-smoke",
  });
  const meetingQueryResult = await callTool(token, 5, "query_openwhispr_meetings", {
    query: meetingPhrase,
    folder_id: meetingsFolder?.id,
  });
  const meetingQuery = JSON.parse(meetingQueryResult.content?.[0]?.text ?? "{}") as { meetings?: unknown[] };

  console.log(JSON.stringify({
    ok: true,
    folders: folders.map((folder) => folder.name),
    memoryHits: memoryQuery.hits?.length ?? 0,
    meetingHits: meetingQuery.meetings?.length ?? 0,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
