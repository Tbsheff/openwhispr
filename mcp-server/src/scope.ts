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

export function toResourceScope(input: ResourceScopeInput): ResourceScope {
  return {
    workspaceId: input.workspace_id,
    teamId: input.team_id,
  };
}

export function hasResourceScope(scope: ResourceScope): boolean {
  return scope.workspaceId !== undefined || scope.teamId !== undefined;
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
