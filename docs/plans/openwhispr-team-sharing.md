---
title: OpenWhispr Proper Team Sharing
status: draft
created: 2026-06-01
owner: team
origin: conversation
---

# OpenWhispr Proper Team Sharing

## Summary

OpenWhispr currently has workspace, team, invitation, and note-sharing UI scaffolding, but the resource data plane is still mostly personal or globally shared. Proper team sharing means notes, folders, meetings, transcriptions, conversations, memory, search, and MCP access are all scoped by one authoritative workspace/team contract and enforced by the server before results are returned.

The implementation should proceed from the authorization/data model outward:

```text
Workspace switcher
  -> ResourceScope on create/list/search/sync
  -> Cloud API validates membership and role
  -> Desktop stores scoped local records and sync cursors
  -> MCP receives authorized workspace/team context
  -> Search/memory/meeting tools query only allowed rows
```

## Current Checkpoint

Branch: `feat/team-sharing-foundation`

Already in flight under `mcp-server/`:

- `workspace_id` and `team_id` columns for MCP folders, notes, transcriptions, and memories.
- Scoped MCP tool inputs and SQL filters for notes, folders, transcriptions, durable memory, `memory_query`, meetings, and account info.
- Same-scope folder validation for `create_note` and `update_note`.
- Same-scope folder joins using `IS NOT DISTINCT FROM` to prevent cross-workspace folder-name leaks and meeting misclassification.
- MCP tests passing locally with 25 tests after the folder-scope fix.

Important repo state:

- `mcp-server/` is currently untracked from the parent repo. Before publishing this work, decide whether `mcp-server/` should become tracked in this repo, live in a separate repo, or be vendored another way.
- The authoritative Cloud API implementation does not appear to be in this checkout. The desktop has client service wrappers for workspace endpoints, but server enforcement must be implemented or verified in the Cloud API codebase before workspace sharing is considered real.

## Goals

- Personal resources remain private by default.
- Workspace resources are visible to authorized workspace members.
- Team-scoped resources are visible to team members plus workspace owners/admins.
- Note link/domain/invite sharing remains an overlay, not the primary team authorization model.
- Search, memory, meetings, and MCP never leak resources outside the authorized scope.
- Existing personal sync behavior continues to work during rollout.

## Non-Goals

- No broad UI redesign beyond the minimum states required to expose scope and permissions.
- No embedding/vector search redesign as part of team sharing.
- No billing-seat policy redesign beyond enforcing existing workspace roles/scopes.
- No cross-workspace global search until scoped search is proven safe.

## Canonical Scope Contract

This is the first gate. The team should not build more sync or MCP behavior until this contract is accepted across desktop, Cloud API, and MCP.

Use one shared scope concept across desktop, Cloud API, and MCP:

```ts
type ResourceScope =
  | { kind: "personal"; workspaceId: null; teamId: null }
  | { kind: "workspace"; workspaceId: string; teamId?: string | null };
```

Rules:

- `workspaceId = null` means personal resource.
- `teamId = null` inside a workspace means workspace-wide resource.
- `teamId != null` means team-restricted resource.
- A non-null `teamId` must resolve to a team inside the same `workspaceId`.
- Tool or request arguments can narrow access, but never grant access.
- The server derives allowed workspaces/teams from the authenticated user, workspace API key, or token claims.
- `created_by` is audit metadata, not an authorization boundary.
- Folder membership must be scope-consistent with the resource using that folder.
- Existing local and cloud records remain personal unless explicitly moved or shared.
- Switching the active workspace does not move existing resources.

Required invariants:

```text
resource.workspace_id IS NOT DISTINCT FROM folder.workspace_id
resource.team_id      IS NOT DISTINCT FROM folder.team_id
```

For nullable scope fields, use nullable equality semantics rather than plain `=`.

## Architecture Decisions

### Decision 1: Auth-Derived Server Scope

Do not rely on the workspace switcher to filter resources after fetch. Every Cloud API and MCP query must apply authorization before returning rows.

Reason: UI-only filtering creates easy leakage through sync, search, MCP, and direct API clients.

Important distinction:

- Client/tool-provided `workspace_id` and `team_id` are filters.
- Auth-derived workspace/team memberships are the permission boundary.
- A request for an unauthorized scope must fail before returning rows.

### Decision 2: Scope Captured At Creation

New notes, meeting recordings, transcriptions, folders, conversations, and memories should capture their scope when created.

Reason: if scope is read later from the current workspace switcher, a user can start a meeting in one workspace and sync it into another after switching.

### Decision 3: Scoped Sync Cursors

Sync cursors must be keyed by resource type and scope.

Examples:

- `lastSyncedAt.notes.personal`
- `lastSyncedAt.notes.workspace.<workspaceId>`
- `lastSyncedAt.folders.workspace.<workspaceId>.team.<teamId>`

Reason: one global cursor can skip data after workspace switches or pull stale cross-workspace records.

### Decision 4: Note Sharing Is An Overlay

`private`, `invited`, `link`, and `domain` sharing should remain note-specific access overlays.

Reason: workspace/team sharing is durable organizational access. Link and invite sharing are exceptions to the normal workspace boundary.

## Implementation Units

### Unit 0: Scope Contract And API Readiness Gate

Status: not started.

Primary files:

- Cloud API repo or service implementation, location to be confirmed.
- `agent-skills/openwhispr-api/SKILL.md`
- `src/types/electron.ts`
- `src/services/NotesService.ts`
- `src/services/FoldersService.ts`
- `src/services/TranscriptionsService.ts`
- `src/services/ConversationsService.ts`
- `mcp-server/src/scope.ts`

Requirements:

- Document the canonical `ResourceScope` model and null semantics.
- Decide whether every `team_id` request must include `workspace_id`. Recommendation: yes for public API contracts; internally, team IDs still validate through their workspace.
- Define allowed transitions:
  - personal to workspace
  - workspace to team
  - team to workspace
  - workspace/team to personal
- Define who may perform each transition.
- Define auth-derived scope claims for users and workspace API keys.
- Update API docs before desktop sync starts.

Exit criteria:

- Cloud API owner confirms route shape, request bodies, and authorization behavior.
- Desktop owner confirms local schema and sync cursor shape.
- MCP owner confirms tool args are filters layered onto auth-derived permissions.
- Product owner confirms whether moving existing personal resources into workspaces is explicit-only.

### Unit 1: MCP Scope Foundation

Status: in progress.

Primary files:

- `mcp-server/migrations/001_init.sql`
- `mcp-server/migrations/002_memories.sql`
- `mcp-server/migrations/003_resource_scope.sql`
- `mcp-server/src/scope.ts`
- `mcp-server/src/index.ts`
- `mcp-server/src/memory.ts`
- `mcp-server/src/meetings.ts`
- `mcp-server/tests/mcp-http.test.ts`

Requirements:

- Add nullable `workspace_id` and `team_id` to folders, notes, transcriptions, and memories.
- Replace global folder-name uniqueness with scoped folder-name uniqueness.
- Add scoped filters to all MCP read/write tools.
- Validate folder scope on note writes.
- Use same-scope folder joins in meeting and memory queries.
- Preserve unscoped existing behavior for current callers.

Test scenarios:

- Unscoped `memory_query` omits workspace/team predicates and params.
- Scoped `memory_query` includes workspace/team predicates for memory, note, and transcription subqueries.
- `create_note` with `folder_id` validates folder scope using nullable equality.
- `update_note` validates folder scope against the existing note scope.
- Meeting and memory joins include same-scope folder predicates.

Verification:

- `cd mcp-server && npm run typecheck`
- `cd mcp-server && npm test`
- `cd mcp-server && npm run test:mcp:local` against a disposable Postgres database before merge.

### Unit 2: Cloud API Authorization And Resource Contract

Status: not started in this checkout.

Primary files:

- Cloud API repo or service implementation, location to be confirmed.
- `agent-skills/openwhispr-api/SKILL.md`
- Desktop service wrappers under `src/services/`

Requirements:

- Implement or verify server-side workspace membership checks.
- Implement or verify team membership checks.
- Bind workspace API keys to a workspace and enforce scopes like `workspace:notes:read`.
- Add workspace/team-aware resource routes or request parameters.
- Filter before ranking/searching, not after.
- Return permission metadata needed by UI, such as `can_manage_share`.
- Reject unauthorized `workspace_id` or `team_id` before querying resource rows.
- Preserve personal routes for backward compatibility while making their personal scope explicit.

Recommended route shape:

```text
GET    /api/workspaces/:workspaceId/notes/list
POST   /api/workspaces/:workspaceId/notes/create
PATCH  /api/workspaces/:workspaceId/notes/update
POST   /api/workspaces/:workspaceId/notes/search
GET    /api/workspaces/:workspaceId/folders/list
POST   /api/workspaces/:workspaceId/folders/create
GET    /api/workspaces/:workspaceId/conversations/list
GET    /api/workspaces/:workspaceId/transcriptions/list
```

Personal routes can remain backward compatible:

```text
/api/notes/*
/api/folders/*
/api/conversations/*
/api/transcriptions/*
```

Test scenarios:

- Workspace member can read workspace-wide notes.
- Non-member receives `404` or `403` consistently.
- Team member can read team-scoped resources.
- Workspace owner/admin can read/manage team-scoped resources.
- Workspace member outside a team cannot read that team resource.
- Workspace API key cannot access another workspace.
- Search results never include inaccessible rows.

### Unit 3: Desktop Scope Plumbing

Status: not started.

Primary files:

- `src/stores/workspaceStore.ts`
- `src/hooks/useWorkspace.ts`
- `src/services/NotesService.ts`
- `src/services/FoldersService.ts`
- `src/services/TranscriptionsService.ts`
- `src/services/ConversationsService.ts`
- `src/services/SyncService.ts`
- `src/helpers/database.js`
- `src/types/electron.ts`

Requirements:

- Add a single scope derivation helper for active personal/workspace/team context.
- Persist `workspace_id` and `team_id` locally for notes, folders, transcriptions, and conversations.
- Thread scope through create, update, list, search, delete, and sync service calls.
- Capture scope at resource creation time.
- Maintain separate sync cursors per scope.
- Build folder ID maps per scope.
- Ensure personal and workspace folders with the same name do not collide locally.
- Do not start this unit until Unit 0 and Unit 2 route contracts are agreed.

Test scenarios:

- Creating a note in personal scope sends no workspace route or scope.
- Creating a note in workspace scope sends workspace route/scope.
- Sync cursors differ between personal and workspace scopes.
- Folder map never maps a personal folder to a workspace cloud folder.
- Switching active workspace does not mutate existing unsynced records into the new scope.
- Pulling workspace notes does not insert them into personal views.
- Team note only appears for team members.
- Folder joins never cross scopes.

### Unit 4: Sharing And Permissions UI

Status: not started.

Primary files:

- `src/components/WorkspaceSwitcher.tsx`
- `src/components/notes/ShareNoteDialog.tsx`
- `src/services/NoteSharingService.ts`
- `src/components/settings/WorkspaceMembersTab.tsx`
- `src/components/settings/WorkspaceTeamsTab.tsx`
- `src/components/settings/WorkspaceDeveloperTab.tsx`

Requirements:

- Remove the owner assumption in `ShareNoteDialog`.
- Render server-returned owner and permission metadata.
- Show resource scope: Personal, Workspace, or Team.
- Disable share/manage controls when the user lacks permission.
- Allow authorized users to move resources between personal/workspace/team scopes if product wants that behavior.
- Keep workspace/team management UI mostly unchanged unless server contract requires tweaks.

Test scenarios:

- Non-owner without manage permission can view but not change sharing settings.
- Workspace admin can manage sharing on workspace resources.
- Team member sees team-scoped notes only for their teams.
- Accepting a workspace invitation refreshes workspaces and selects the accepted workspace.

### Unit 5: MCP Authorization Hardening

Status: partially prepared by Unit 1, not complete.

Primary files:

- `mcp-server/src/auth.ts`
- `mcp-server/src/index.ts`
- `mcp-server/src/memory.ts`
- `mcp-server/src/meetings.ts`
- `mcp-server/tests/mcp-http.test.ts`

Requirements:

- Replace GitHub-org-only authorization as the resource boundary.
- Add an access context for MCP requests:

```ts
interface McpAccessContext {
  userId: string;
  workspaceIds: string[];
  defaultWorkspaceId: string | null;
  scopes: string[];
  teamIdsByWorkspace: Record<string, string[]>;
}
```

- Ensure tool-provided `workspace_id` and `team_id` are validated against access context.
- Workspace API keys and OAuth users should both produce an access context.
- `get_account_info` should return authorized workspace context and scoped corpus counts.
- Treat tool-provided `workspace_id` and `team_id` as narrowing filters only.
- Reject unauthorized scope filters before calling data-layer queries.

Test scenarios:

- Authorized workspace tool call succeeds.
- Tool call for unauthorized workspace fails before querying rows.
- Tool call for unauthorized team fails before querying rows.
- Unscoped legacy calls preserve current behavior only where intentionally allowed.

### Unit 6: Migration And Backfill

Status: not started.

Primary files:

- `src/helpers/database.js`
- Cloud API migrations
- `mcp-server/migrations/*.sql`
- Migration/backfill scripts in the Cloud API repo

Requirements:

- Keep existing records personal by default with `workspace_id = null`.
- Add scoped folder uniqueness without breaking existing `Personal` and `Meetings` folders.
- Backfill workspace-owned records only if the source of truth can prove ownership.
- Validate generated/search-vector behavior against real Postgres, not only unit tests.

Test scenarios:

- Existing personal database opens and migrates.
- Duplicate folder names work across scopes and fail within the same scope.
- Real Postgres migration smoke passes from a fresh database.
- Real Postgres migration smoke passes from a pre-scope database.

## Rollout Plan

1. Complete Unit 0 scope contract and API readiness gate.
2. Finish and review current Unit 1 MCP foundation without treating it as an authorization boundary yet.
3. Locate Cloud API implementation and land Unit 2 authorization/resource contract.
4. Land Unit 3 desktop persistence and scoped sync behind `VITE_WORKSPACES_ENABLED`.
5. Land Unit 5 MCP authorization hardening once Cloud API access context exists.
6. Land Unit 4 sharing/permission UI updates.
7. Run Unit 6 migration/backfill verification.
8. Enable team-scoped sync separately from workspace UI scaffolding.
9. Enable for internal workspace first.
10. Monitor sync/search/MCP leakage signals.
11. Expand rollout to beta users.

## Team Ownership

Suggested ownership split:

- Cloud/API owner: Unit 2 authorization, workspace API keys, server-side tests.
- Desktop owner: Unit 3 local schema, services, sync, workspace switch behavior.
- MCP owner: Unit 1 and Unit 5 tools, auth context, real Postgres smoke.
- Product/design owner: Unit 4 permission states, share/move UX, error copy.
- QA owner: cross-user and cross-workspace regression matrix.

## Review Gates

Each unit should pass:

- Scope contract gate before implementation that depends on resource ownership.
- Cloud API readiness gate before desktop scoped sync.
- Desktop sync gate before enabling team-scoped sync.
- MCP auth gate before using MCP scope filters as tenant isolation.
- Spec compliance review: does it implement the requested behavior and nothing unrelated?
- Code quality review: does it keep scope enforcement clear, testable, and maintainable?
- Security review for Units 2 and 5.
- Real migration smoke for Units 1 and 6.

## Open Questions

- Where is the authoritative Cloud API implementation for `/api/workspaces`, `/api/notes`, and workspace API keys?
- Should workspace/team resources sync automatically for every joined workspace or only active/recent workspaces?
- Should team-scoped notes be movable to workspace-wide by admins?
- Should MCP allow unscoped legacy access after workspace authorization lands, or require explicit personal/workspace scope?
- Should note link/domain sharing expose workspace-owned notes to non-members, and what audit trail is required?

## Immediate Next Steps

1. Decide how `mcp-server/` should be tracked or packaged.
2. Run a scope-contract review with Cloud API, desktop, MCP, and product owners.
3. Rerun spec and quality review on the current Unit 1 folder-scope fix.
4. Run `npm run test:mcp:local` against disposable Postgres.
5. Locate Cloud API repo/service and assign Unit 2 owner.
6. Start Unit 3 only after Unit 0 and Unit 2 contracts are confirmed.
