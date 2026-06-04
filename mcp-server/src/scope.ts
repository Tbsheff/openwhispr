import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import type { DbParam } from "./db.js";

export const resourceScopeSchema = {
  workspace_id: z.string().min(1).optional().describe("Restrict operation to this workspace ID"),
  team_id: z.string().min(1).optional().describe("Restrict operation to this team ID"),
};

export interface ResourceScopeInput {
  workspace_id?: string;
  team_id?: string;
}

export interface ResourceScope {
  workspaceId?: string;
  teamId?: string;
}

export interface AccessContext {
  allowUnscoped: boolean;
  workspaceIds: readonly string[];
  teamIdsByWorkspace: Readonly<Record<string, readonly string[]>>;
}

const legacyAccessContext: AccessContext = {
  allowUnscoped: true,
  workspaceIds: [],
  teamIdsByWorkspace: {},
};

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function teamMap(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  return Object.fromEntries(
    Object.entries(value)
      .map(([workspaceId, teamIds]) => [workspaceId, stringArray(teamIds)] as const)
      .filter(([, teamIds]) => teamIds.length > 0)
  );
}

export function accessContextFromAuth(authInfo?: AuthInfo): AccessContext {
  const extra = authInfo?.extra;
  if (!extra) return legacyAccessContext;

  return {
    allowUnscoped: extra.allowUnscoped !== false,
    workspaceIds: stringArray(extra.workspaceIds),
    teamIdsByWorkspace: teamMap(extra.teamIdsByWorkspace),
  };
}

export function toResourceScope(input: ResourceScopeInput): ResourceScope {
  return {
    workspaceId: input.workspace_id,
    teamId: input.team_id,
  };
}

export function hasResourceScope(scope: ResourceScope): boolean {
  return scope.workspaceId !== undefined || scope.teamId !== undefined;
}

export function authorizeResourceScope(input: ResourceScopeInput, accessContext: AccessContext): ResourceScope {
  const scope = toResourceScope(input);
  if (!hasResourceScope(scope)) {
    if (accessContext.allowUnscoped) return scope;
    throw new Error("A workspace_id is required for this token.");
  }

  if (!scope.workspaceId) {
    throw new Error("team_id requires workspace_id.");
  }

  if (!accessContext.workspaceIds.includes(scope.workspaceId)) {
    throw new Error("Unauthorized workspace_id.");
  }

  if (scope.teamId) {
    const allowedTeams = accessContext.teamIdsByWorkspace[scope.workspaceId] ?? [];
    if (!allowedTeams.includes(scope.teamId)) {
      throw new Error("Unauthorized team_id.");
    }
  }

  return scope;
}

export function appendScopeFilters(
  filters: string[],
  params: DbParam[],
  scope: ResourceScope,
  tableAlias?: string
): void {
  const prefix = tableAlias ? `${tableAlias}.` : "";

  if (scope.workspaceId !== undefined) {
    filters.push(`${prefix}workspace_id = $${params.length + 1}`);
    params.push(scope.workspaceId);
  }

  if (scope.teamId !== undefined) {
    filters.push(`${prefix}team_id = $${params.length + 1}`);
    params.push(scope.teamId);
  }
}

export function scopeResponse(scope: ResourceScope): { workspaceId: string | null; teamId: string | null } {
  return {
    workspaceId: scope.workspaceId ?? null,
    teamId: scope.teamId ?? null,
  };
}
