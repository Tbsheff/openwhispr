export async function prepareOnboardingWorkspace({
  getPendingInvitationToken,
  acceptInvitation,
  clearPendingInvitationToken,
  refreshWorkspaces,
  getWorkspaceState,
  createWorkspace,
  setActiveWorkspaceId,
  defaultWorkspaceName,
}) {
  const pendingInvitation = getPendingInvitationToken();
  if (pendingInvitation) {
    const accepted = await acceptInvitation(pendingInvitation);
    clearPendingInvitationToken();
    await refreshWorkspaces();
    setActiveWorkspaceId(accepted.workspace_id);
    return {
      messageKey: "onboarding.setup.workspace.joinedDescription",
    };
  }

  await refreshWorkspaces();
  const { workspaces, activeWorkspaceId } = getWorkspaceState();
  const activeStillValid =
    activeWorkspaceId !== null &&
    workspaces.some((workspace) => workspace.id === activeWorkspaceId);

  if (activeStillValid) {
    const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId);
    return {
      messageKey: "onboarding.setup.workspace.readyDescription",
      workspaceName: activeWorkspace?.name,
    };
  }

  if (workspaces.length > 0) {
    const workspace = workspaces[0];
    setActiveWorkspaceId(workspace.id);
    return {
      messageKey: "onboarding.setup.workspace.readyDescription",
      workspaceName: workspace.name,
    };
  }

  const workspace = await createWorkspace(defaultWorkspaceName);
  setActiveWorkspaceId(workspace.id);
  return {
    messageKey: "onboarding.setup.workspace.createdDescription",
    workspaceName: workspace.name,
  };
}
