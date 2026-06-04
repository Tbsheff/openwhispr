export type TeamAccessEntitlement =
  | "unmeteredUsage"
  | "billingIncluded"
  | "integrationAccess"
  | "suppressPaywallPrompts";

export interface TeamAccessPolicy {
  readonly included: boolean;
  readonly plan: "business";
  readonly status: "active";
  readonly entitlements: Readonly<Record<TeamAccessEntitlement, boolean>>;
}

const INCLUDED_TEAM_ACCESS_POLICY: TeamAccessPolicy = {
  included: true,
  plan: "business",
  status: "active",
  entitlements: {
    unmeteredUsage: true,
    billingIncluded: true,
    integrationAccess: true,
    suppressPaywallPrompts: true,
  },
};

export function getTeamAccessPolicy(): TeamAccessPolicy {
  return INCLUDED_TEAM_ACCESS_POLICY;
}
