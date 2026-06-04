import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WORKSPACES_ENABLED } from "../lib/features";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { Workspace } from "../types/electron";
import logger from "../utils/logger";
import { InvitationsService } from "../services/InvitationsService";
import {
  clearPendingInvitationToken,
  consumePendingInvitationToken,
} from "../lib/pendingInvitationToken";
import { prepareOnboardingWorkspace } from "../helpers/onboardingWorkspaceBootstrap";

export type WorkspaceBootstrapStatus = "idle" | "loading" | "ready" | "error";

export interface WorkspaceBootstrapState {
  status: WorkspaceBootstrapStatus;
  messageKey?: string;
  workspaceName?: string;
}

interface UseOnboardingWorkspaceBootstrapOptions {
  currentStep: number;
  isSignedIn: boolean;
  skipAuth: boolean;
  userEmail?: string | null;
  userName?: string | null;
}

interface OnboardingWorkspaceResult {
  messageKey?: string;
  workspaceName?: string;
}

interface WorkspaceStoreSnapshot {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
}

interface PrepareOnboardingWorkspaceDeps {
  getPendingInvitationToken: () => string | null;
  acceptInvitation: (token: string) => Promise<{ workspace_id: string }>;
  clearPendingInvitationToken: () => void;
  refreshWorkspaces: () => Promise<void>;
  getWorkspaceState: () => WorkspaceStoreSnapshot;
  createWorkspace: (name: string) => Promise<Workspace>;
  setActiveWorkspaceId: (id: string | null) => void;
  defaultWorkspaceName: string;
}

type PrepareOnboardingWorkspace = (
  deps: PrepareOnboardingWorkspaceDeps
) => Promise<OnboardingWorkspaceResult>;

interface UseOnboardingWorkspaceBootstrapResult {
  state: WorkspaceBootstrapState;
  defaultWorkspaceName: string;
  retry: () => void;
  isReady: boolean;
}

const prepareWorkspaceBootstrap: PrepareOnboardingWorkspace = prepareOnboardingWorkspace;

function getDefaultWorkspaceName(userEmail?: string | null, userName?: string | null): string {
  const email = userEmail ?? "";
  const domain = email.includes("@") ? email.split("@")[1]?.split(".")[0] : "";
  if (domain) return `${domain.charAt(0).toUpperCase()}${domain.slice(1)} Workspace`;
  if (userName) return `${userName.split(" ")[0]} Workspace`;
  return "OpenWhispr Workspace";
}

export function useOnboardingWorkspaceBootstrap({
  currentStep,
  isSignedIn,
  skipAuth,
  userEmail,
  userName,
}: UseOnboardingWorkspaceBootstrapOptions): UseOnboardingWorkspaceBootstrapResult {
  const [state, setState] = useState<WorkspaceBootstrapState>({
    status: WORKSPACES_ENABLED ? "idle" : "ready",
  });
  const inFlightRef = useRef(false);
  const refreshWorkspaces = useWorkspaceStore((s) => s.refresh);
  const createWorkspace = useWorkspaceStore((s) => s.createWorkspace);
  const setActiveWorkspaceId = useWorkspaceStore((s) => s.setActiveWorkspaceId);

  const defaultWorkspaceName = useMemo(
    () => getDefaultWorkspaceName(userEmail, userName),
    [userEmail, userName]
  );

  const prepareWorkspace = useCallback(async (): Promise<void> => {
    if (!WORKSPACES_ENABLED || inFlightRef.current) return;

    inFlightRef.current = true;
    setState({ status: "loading" });

    try {
      const result = await prepareWorkspaceBootstrap({
        getPendingInvitationToken: consumePendingInvitationToken,
        acceptInvitation: InvitationsService.accept,
        clearPendingInvitationToken,
        refreshWorkspaces,
        getWorkspaceState: useWorkspaceStore.getState,
        createWorkspace,
        setActiveWorkspaceId,
        defaultWorkspaceName,
      });
      setState({
        status: "ready",
        ...result,
      });
    } catch (error) {
      logger.error(
        "Failed to prepare onboarding workspace",
        { error: error instanceof Error ? error.message : String(error) },
        "workspaces"
      );
      setState({
        status: "error",
        messageKey: "onboarding.setup.workspace.errorDescription",
      });
    } finally {
      inFlightRef.current = false;
    }
  }, [createWorkspace, defaultWorkspaceName, refreshWorkspaces, setActiveWorkspaceId]);

  useEffect(() => {
    if (!WORKSPACES_ENABLED || !isSignedIn || skipAuth || currentStep < 1) return;
    if (state.status !== "idle") return;
    void prepareWorkspace();
  }, [currentStep, isSignedIn, prepareWorkspace, skipAuth, state.status]);

  const retry = useCallback((): void => {
    void prepareWorkspace();
  }, [prepareWorkspace]);

  return {
    state,
    defaultWorkspaceName,
    retry,
    isReady: !WORKSPACES_ENABLED || state.status === "ready",
  };
}
