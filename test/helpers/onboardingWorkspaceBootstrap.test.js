const test = require("node:test");
const assert = require("node:assert/strict");

function createDeps(overrides = {}) {
  const calls = [];
  const deps = {
    getPendingInvitationToken: () => null,
    acceptInvitation: async () => ({ workspace_id: "accepted-workspace", role: "member" }),
    clearPendingInvitationToken: () => calls.push(["clearPendingInvitationToken"]),
    refreshWorkspaces: async () => calls.push(["refreshWorkspaces"]),
    getWorkspaceState: () => ({ workspaces: [], activeWorkspaceId: null }),
    createWorkspace: async (name) => {
      calls.push(["createWorkspace", name]);
      return { id: "created-workspace", name };
    },
    setActiveWorkspaceId: (id) => calls.push(["setActiveWorkspaceId", id]),
    defaultWorkspaceName: "Acme Workspace",
    ...overrides,
  };
  return { deps, calls };
}

test("accepts pending invitation before inspecting workspaces", async () => {
  const { prepareOnboardingWorkspace } = await import(
    "../../src/helpers/onboardingWorkspaceBootstrap.js"
  );
  const { deps, calls } = createDeps({
    getPendingInvitationToken: () => "invite-token",
  });

  const result = await prepareOnboardingWorkspace(deps);

  assert.deepEqual(result, {
    messageKey: "onboarding.setup.workspace.joinedDescription",
  });
  assert.deepEqual(calls, [
    ["refreshWorkspaces"],
    ["setActiveWorkspaceId", "accepted-workspace"],
    ["clearPendingInvitationToken"],
  ]);
});

test("keeps pending invitation token when local workspace activation fails", async () => {
  const { prepareOnboardingWorkspace } = await import(
    "../../src/helpers/onboardingWorkspaceBootstrap.js"
  );
  const { deps, calls } = createDeps({
    getPendingInvitationToken: () => "invite-token",
    setActiveWorkspaceId: (id) => {
      calls.push(["setActiveWorkspaceId", id]);
      throw new Error("activation failed");
    },
  });

  await assert.rejects(() => prepareOnboardingWorkspace(deps), /activation failed/);
  assert.deepEqual(calls, [
    ["refreshWorkspaces"],
    ["setActiveWorkspaceId", "accepted-workspace"],
  ]);
});

test("keeps an existing valid active workspace", async () => {
  const { prepareOnboardingWorkspace } = await import(
    "../../src/helpers/onboardingWorkspaceBootstrap.js"
  );
  const { deps, calls } = createDeps({
    getWorkspaceState: () => ({
      activeWorkspaceId: "workspace-1",
      workspaces: [{ id: "workspace-1", name: "Team Notes" }],
    }),
  });

  const result = await prepareOnboardingWorkspace(deps);

  assert.deepEqual(result, {
    messageKey: "onboarding.setup.workspace.readyDescription",
    workspaceName: "Team Notes",
  });
  assert.deepEqual(calls, [["refreshWorkspaces"]]);
});

test("selects the first existing workspace when no active workspace is valid", async () => {
  const { prepareOnboardingWorkspace } = await import(
    "../../src/helpers/onboardingWorkspaceBootstrap.js"
  );
  const { deps, calls } = createDeps({
    getWorkspaceState: () => ({
      activeWorkspaceId: "stale-workspace",
      workspaces: [{ id: "workspace-2", name: "Shared Voice" }],
    }),
  });

  const result = await prepareOnboardingWorkspace(deps);

  assert.deepEqual(result, {
    messageKey: "onboarding.setup.workspace.readyDescription",
    workspaceName: "Shared Voice",
  });
  assert.deepEqual(calls, [
    ["refreshWorkspaces"],
    ["setActiveWorkspaceId", "workspace-2"],
  ]);
});

test("creates a default workspace when the user has none", async () => {
  const { prepareOnboardingWorkspace } = await import(
    "../../src/helpers/onboardingWorkspaceBootstrap.js"
  );
  const { deps, calls } = createDeps();

  const result = await prepareOnboardingWorkspace(deps);

  assert.deepEqual(result, {
    messageKey: "onboarding.setup.workspace.createdDescription",
    workspaceName: "Acme Workspace",
  });
  assert.deepEqual(calls, [
    ["refreshWorkspaces"],
    ["createWorkspace", "Acme Workspace"],
    ["setActiveWorkspaceId", "created-workspace"],
  ]);
});
