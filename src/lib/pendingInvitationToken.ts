const PENDING_INVITATION_TOKEN_KEY = "pendingInvitationToken";

export function storePendingInvitationToken(token: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(PENDING_INVITATION_TOKEN_KEY, token);
}

export function consumePendingInvitationToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(PENDING_INVITATION_TOKEN_KEY);
}

export function clearPendingInvitationToken(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(PENDING_INVITATION_TOKEN_KEY);
}
