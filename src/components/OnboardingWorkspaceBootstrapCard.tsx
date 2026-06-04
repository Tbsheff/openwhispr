import type { ReactElement } from "react";
import { Building2, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { WORKSPACES_ENABLED } from "../lib/features";
import type { WorkspaceBootstrapState } from "../hooks/useOnboardingWorkspaceBootstrap";
import { Button } from "./ui/button";

interface OnboardingWorkspaceBootstrapCardProps {
  state: WorkspaceBootstrapState;
  defaultWorkspaceName: string;
  onRetry: () => void;
}

export default function OnboardingWorkspaceBootstrapCard({
  state,
  defaultWorkspaceName,
  onRetry,
}: OnboardingWorkspaceBootstrapCardProps): ReactElement | null {
  const { t } = useTranslation();

  if (!WORKSPACES_ENABLED) return null;

  const isLoading = state.status === "loading";
  const isError = state.status === "error";
  const messageKey =
    state.messageKey ??
    (isLoading
      ? "onboarding.setup.workspace.preparingDescription"
      : "onboarding.setup.workspace.readyDescription");

  return (
    <div className="rounded-lg border border-border/60 bg-surface-1 p-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Building2 className="h-4 w-4" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">
            {isError
              ? t("onboarding.setup.workspace.errorTitle")
              : isLoading
                ? t("onboarding.setup.workspace.preparingTitle")
                : t("onboarding.setup.workspace.readyTitle")}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {t(messageKey, {
              name: state.workspaceName ?? defaultWorkspaceName,
            })}
          </p>
        </div>
        {isError && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 shrink-0 text-xs"
            onClick={onRetry}
          >
            {t("onboarding.setup.workspace.retry")}
          </Button>
        )}
      </div>
    </div>
  );
}
