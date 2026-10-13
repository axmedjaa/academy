import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getMyActivity } from "@/lib/my-activity-actions";
import type { AuditResult } from "@/lib/audit-query";
import { AuthLink, Card, SecondaryLinkButton } from "@/lib/ui/auth-components";
import { color, spacing } from "@/lib/ui/theme";
import { PaginationNav } from "@/components/pagination-nav";

/**
 * "My Activity" — a personal, role-agnostic page reachable from both
 * consoles' own "Account settings" link (same spot `/account/security`
 * already sits, outside either shell's DESIGN.md-documented nav tree —
 * see that page's own module comment for why this route isn't part of
 * `app/academy/*`/`app/platform/*` at all). Every signed-in user gets this
 * page regardless of role or permission — unlike `/academy/audit-logs`
 * (Owner/Admin only) and `/platform/audit-logs` (the `queryAuditLogs`
 * grant), which stay exactly as they are: this is a *third*, narrower view
 * onto the same `audit_logs` table, hard-scoped server-side to the caller's
 * own `actorUserId` (lib/my-activity.ts), never anyone else's — the two
 * oversight pages' own roles/permissions are untouched.
 *
 * Same GET-query-param filter/pagination convention as `/academy/audit-logs`
 * and `/platform/audit-logs` (plain `<form method="get">`, re-navigate,
 * server-render) — deliberately no "Actor" filter/column at all, since
 * every row on this page is already known to be the viewer's own.
 */
export default async function MyActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await getAuthContext();
  if (!context) {
    redirect("/login");
  }

  const params = await searchParams;
  const get = (key: string): string => {
    const value = params[key];
    return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
  };

  const action = get("action");
  const result = get("result");
  const createdFrom = get("createdFrom");
  const createdTo = get("createdTo");
  const pageParam = Number.parseInt(get("page"), 10);
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;

  const response = await getMyActivity(
    {
      action: action || undefined,
      result: (result || undefined) as AuditResult | undefined,
      createdFrom: createdFrom ? new Date(createdFrom) : undefined,
      createdTo: createdTo ? new Date(createdTo) : undefined,
    },
    { page },
  );

  const backHref = context.platformRole ? "/platform/academies" : "/academy/dashboard";

  return (
    <div style={{ minHeight: "100vh", backgroundColor: color.bg, padding: spacing.xl }}>
      <div style={{ maxWidth: 860, margin: "0 auto", display: "flex", flexDirection: "column", gap: spacing.xl }}>
        <div>
          <SecondaryLinkButton href={backHref} style={{ marginBottom: spacing.md }}>
            {context.platformRole ? "← Back to platform console" : "← Back to dashboard"}
          </SecondaryLinkButton>
          <h1 style={{ margin: 0, color: color.text }}>My activity</h1>
          <p style={{ margin: 0, marginTop: spacing.xxs, color: color.textMuted }}>
            A record of actions taken on your own account. Only your own activity ever appears here.
          </p>
        </div>

        <Card>
          <form method="get" style={{ display: "flex", flexWrap: "wrap", gap: spacing.sm, alignItems: "flex-end", marginBottom: spacing.md }}>
            <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.8rem", color: color.textMuted, minWidth: 160 }}>
              Action
              <input
                type="text"
                name="action"
                defaultValue={action}
                style={{ padding: "0.5rem 0.65rem", fontSize: "0.85rem", border: `1px solid ${color.border}`, borderRadius: 8, color: color.text }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.8rem", color: color.textMuted, minWidth: 140 }}>
              Result
              <select
                name="result"
                defaultValue={result}
                style={{ padding: "0.5rem 0.65rem", fontSize: "0.85rem", border: `1px solid ${color.border}`, borderRadius: 8, color: color.text }}
              >
                <option value="">Any</option>
                <option value="success">Success</option>
                <option value="failure">Failure</option>
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.8rem", color: color.textMuted, minWidth: 140 }}>
              From
              <input
                type="date"
                name="createdFrom"
                defaultValue={createdFrom}
                style={{ padding: "0.5rem 0.65rem", fontSize: "0.85rem", border: `1px solid ${color.border}`, borderRadius: 8, color: color.text }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.8rem", color: color.textMuted, minWidth: 140 }}>
              To
              <input
                type="date"
                name="createdTo"
                defaultValue={createdTo}
                style={{ padding: "0.5rem 0.65rem", fontSize: "0.85rem", border: `1px solid ${color.border}`, borderRadius: 8, color: color.text }}
              />
            </label>
            <button
              type="submit"
              style={{
                backgroundColor: color.card,
                color: color.text,
                border: `1px solid ${color.border}`,
                borderRadius: 8,
                padding: "0.5rem 0.9rem",
                fontSize: "0.85rem",
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Filter
            </button>
            {(action || result || createdFrom || createdTo) && (
              <AuthLink href="/account/activity">Clear filters</AuthLink>
            )}
          </form>

          {!response.ok ? (
            <p role="alert" style={{ color: color.statusRed, fontSize: "0.9rem" }}>
              {response.error.message}
            </p>
          ) : response.data.rows.length === 0 ? (
            <p style={{ margin: 0, padding: `${spacing.md} 0`, color: color.textMuted, fontSize: "0.9rem", textAlign: "center" }}>
              {action || result || createdFrom || createdTo
                ? "No activity matches these filters."
                : "No activity recorded on your account yet."}
            </p>
          ) : (
            <>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
                  <thead>
                    <tr style={{ textAlign: "left", borderBottom: `1px solid ${color.border}` }}>
                      <th style={{ padding: "0.4rem 0", color: color.textMuted, fontWeight: 500 }}>When</th>
                      <th style={{ padding: "0.4rem 0", color: color.textMuted, fontWeight: 500 }}>Action</th>
                      <th style={{ padding: "0.4rem 0", color: color.textMuted, fontWeight: 500 }}>Entity</th>
                      <th style={{ padding: "0.4rem 0", color: color.textMuted, fontWeight: 500 }}>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {response.data.rows.map((row) => (
                      <tr key={row.id} style={{ borderBottom: `1px solid ${color.border}` }}>
                        <td style={{ padding: "0.6rem 0", whiteSpace: "nowrap", color: color.textMuted }}>
                          {row.createdAt.toLocaleString()}
                        </td>
                        <td style={{ padding: "0.6rem 0", color: color.text }}>{row.action}</td>
                        <td style={{ padding: "0.6rem 0", color: color.text }}>{row.entityType}</td>
                        <td style={{ padding: "0.6rem 0" }}>
                          <span
                            style={{
                              display: "inline-block",
                              backgroundColor: row.result === "success" ? color.statusGreenBg : color.statusRedBg,
                              color: row.result === "success" ? color.statusGreen : color.statusRed,
                              borderRadius: 999,
                              padding: "0.15rem 0.6rem",
                              fontSize: "0.75rem",
                              fontWeight: 600,
                            }}
                            title={row.result === "failure" && row.failureReason ? row.failureReason : undefined}
                          >
                            {row.result}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <PaginationNav
                page={response.data.page}
                pageSize={response.data.pageSize}
                totalCount={response.data.totalCount}
                searchParams={params}
              />
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
