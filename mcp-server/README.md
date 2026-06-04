# OpenWhispr MCP Server

A self-hosted [Model Context Protocol](https://modelcontextprotocol.io/) server that gives AI assistants (Claude, Cursor, Warp) access to your team's shared OpenWhispr notes, transcriptions, and folders.

Authentication is via **GitHub OAuth** restricted to your GitHub organization — only org members can connect.

## Setup

### 1. Create a GitHub OAuth App

1. Go to your GitHub org **Settings → Developer settings → OAuth Apps → New OAuth App**
2. Set the **Authorization callback URL** to `https://your-server-url/github/callback`
3. Note the **Client ID** and generate a **Client Secret**

### 2. Start Postgres

```bash
cd mcp-server
docker run --rm --name openwhispr-postgres \
  -e POSTGRES_USER=openwhispr \
  -e POSTGRES_PASSWORD=openwhispr \
  -e POSTGRES_DB=openwhispr \
  -p 5432:5432 \
  postgres:16-alpine
```

Or use an existing Postgres instance (e.g. Neon).

### 3. Install and configure

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

```
DATABASE_URL=postgresql://openwhispr:openwhispr@localhost:5432/openwhispr
SERVER_URL=https://mcp.yourcompany.com
GITHUB_CLIENT_ID=Iv1.abc123
GITHUB_CLIENT_SECRET=your_secret
GITHUB_ORG=your-github-org
JWT_SECRET=$(openssl rand -hex 32)
```

### 4. Run migrations and start

```bash
npm run migrate
npm run dev
```

The local Worker runs through Wrangler and exposes:

- `/mcp` — MCP Streamable HTTP endpoint (OAuth-protected)
- `/authorize` — OAuth authorization (redirects to GitHub)
- `/token` — OAuth token exchange
- `/register` — Dynamic client registration
- `/github/callback` — GitHub OAuth callback
- `/health` — Health check (no auth)
- `/.well-known/oauth-authorization-server` — OAuth metadata discovery

## Connect to AI assistants

The MCP server uses **Streamable HTTP transport with OAuth** — clients connect to the remote URL and authenticate via GitHub.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "openwhispr": {
      "url": "https://mcp.yourcompany.com/mcp"
    }
  }
}
```

Claude will discover the OAuth metadata, open a browser for GitHub login, and handle the token exchange automatically.

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "openwhispr": {
      "url": "https://mcp.yourcompany.com/mcp"
    }
  }
}
```

### Warp

Add to your Warp MCP config:

```json
{
  "openwhispr": {
    "serverUrl": "https://mcp.yourcompany.com/mcp"
  }
}
```

No local install needed — team members just add the URL and sign in with GitHub.

## Auth flow

```
Client → /authorize → GitHub OAuth → /github/callback
  │                                        │
  │   ←─── verify org membership ────────┘
  │   ←─── issue auth code ────────────┘
  │
Client → /token (exchange code for JWT)
  │
Client → /mcp (Bearer JWT)
```

Only members of the configured `GITHUB_ORG` can complete the OAuth flow.

## Available tools

| Tool | Description |
|------|-------------|
| `remember_memory` | Create a durable memory for facts, preferences, decisions, tasks, or notes |
| `search_memories` | Full-text search durable memories, with optional kind and tag filters |
| `get_memory` | Get a durable memory by ID |
| `update_memory` | Update a durable memory |
| `delete_memory` | Soft-delete a durable memory |
| `memory_query` | Enzo Brain-style search across memories, notes, and transcriptions; returns ranked hits and formatted context |
| `memory_stats` | Count memories, notes, transcriptions, folders, and deleted records |
| `memory_status` | Health check for the Postgres memory/search backend |
| `query_openwhispr_meetings` | Granola-style natural-language search over meeting notes; returns matching meetings and compact context |
| `list_meeting_folders` | List meeting folders with meeting counts |
| `list_meetings` | Discover meetings by folder, attendee, date range, and limit |
| `get_meetings` | Retrieve full meeting notes by IDs or content query |
| `get_meeting_transcript` | Fetch the raw transcript for a meeting note |
| `get_account_info` | Confirm the connected account, server URL, GitHub org, capabilities, and corpus counts |
| `list_notes` | List notes, filter by type or folder |
| `get_note` | Get a note with full content |
| `search_notes` | Full-text search across notes |
| `create_note` | Create a new note |
| `update_note` | Update a note's title, content, or folder |
| `delete_note` | Soft-delete a note |
| `list_transcriptions` | List recent transcriptions |
| `get_transcription` | Get a transcription by ID |
| `create_transcription` | Store a new transcription |
| `list_folders` | List all folders |
| `create_folder` | Create a new folder |

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | `postgresql://...localhost:5432/openwhispr` | Postgres connection string |
| `SERVER_URL` | Yes | `http://localhost:3001` | Public URL of this server |
| `GITHUB_CLIENT_ID` | Yes | | GitHub OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | Yes | | GitHub OAuth App client secret |
| `GITHUB_ORG` | Yes | | GitHub org for access restriction |
| `JWT_SECRET` | Yes | | 32+ byte hex secret for signing JWTs |
| `PORT` | No | `3001` | HTTP listen port |

## Deploy

### 1. Create KV namespace

```bash
npx wrangler kv namespace create AUTH_KV
npx wrangler kv namespace create AUTH_KV --preview
```

Copy the IDs into `wrangler.toml`.

### 2. Set secrets

```bash
npx wrangler secret put DATABASE_URL
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put GITHUB_ORG
npx wrangler secret put JWT_SECRET
```

### 3. Update SERVER_URL in `wrangler.toml`

Set it to your Worker's URL (e.g. `https://openwhispr-mcp.your-subdomain.workers.dev`).

### 4. Deploy

```bash
npm run deploy
```

### 5. Run migrations against Neon

```bash
DATABASE_URL=postgresql://... npm run migrate
```

### Local dev

```bash
npm run dev
```

This uses `wrangler dev` with local KV simulation.

### Local verification

```bash
npm run typecheck
npm test
```

To smoke-test a DB-backed MCP tool call against a local Postgres database:

```bash
DATABASE_URL=postgresql://openwhispr:openwhispr@localhost:5432/openwhispr npm run migrate
DATABASE_URL=postgresql://openwhispr:openwhispr@localhost:5432/openwhispr npm run test:mcp:local
```
