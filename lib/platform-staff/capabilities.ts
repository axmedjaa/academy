/**
 * PLAN.md §5 Master Permission Matrix: "The only grantable capabilities in
 * this phase are: recordSubscriptionPayment (data entry only, not
 * verification), queryAuditLogs, and read access to getPlatformReports'
 * non-revenue views." `getPlatformReports` here is deliberately the same
 * capability identifier as the (not-yet-implemented) server action itself
 * — it is a distinct identifier from the ungrantable `platform.revenue.view`
 * (lib/auth/permissions.ts), which is what actually gates the revenue
 * breakdowns; granting `getPlatformReports` only ever exposes the
 * non-revenue views, per PLAN.md/DESIGN.md.
 */
export const GRANTABLE_CAPABILITIES = [
  "recordSubscriptionPayment",
  "queryAuditLogs",
  "getPlatformReports",
] as const;

export type GrantableCapability = (typeof GRANTABLE_CAPABILITIES)[number];

export function isGrantableCapability(
  capability: string,
): capability is GrantableCapability {
  return (GRANTABLE_CAPABILITIES as readonly string[]).includes(capability);
}

export const CAPABILITY_LABELS: Record<GrantableCapability, string> = {
  recordSubscriptionPayment: "Record subscription payments (data entry only)",
  queryAuditLogs: "View platform audit logs",
  getPlatformReports: "View platform reports (non-revenue views)",
};

/**
 * UI-only permission-group presets (PLAN.md Decision #16 / DESIGN.md §8
 * Platform Owner Screens: "preset buttons... UI-only convenience, ticks the
 * same underlying toggles, no separate group concept, no permission-group
 * database model"). A preset button just checks several GRANTABLE_CAPABILITIES
 * toggles at once; nothing is persisted about the preset itself, only the
 * resulting individual grant rows.
 *
 * PLAN.md names the four preset buttons but doesn't enumerate their
 * membership, so this mapping is a judgment call. Reasoning, given only 3
 * grantable capabilities exist in Phase 1 (more will be added in later
 * phases, at which point these presets can differentiate further):
 *  - Support: staff answering "what happened" questions need the audit
 *    trail only — no payment entry, no reports.
 *  - Finance: staff entering payments also want the reports view to
 *    reconcile what they've recorded; they have no need for raw audit
 *    log access.
 *  - Onboarding: staff tracking academies through setup need the
 *    read-only reports view to see onboarding/subscription progress —
 *    payment verification and academy activation stay owner-only
 *    regardless of any grant, and onboarding staff have no particular
 *    need for audit log access.
 *  - Technical: staff diagnosing platform issues want both the audit
 *    trail and the reports view, but have no reason to enter payments.
 */
export const PERMISSION_PRESETS: Record<string, readonly GrantableCapability[]> = {
  Support: ["queryAuditLogs"],
  Finance: ["recordSubscriptionPayment", "getPlatformReports"],
  Onboarding: ["getPlatformReports"],
  Technical: ["queryAuditLogs", "getPlatformReports"],
};
