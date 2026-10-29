import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasPermission } from "@/lib/auth/permissions";
import { EXPIRING_SUBSCRIPTIONS_DEFAULT_LIMIT, getPlatformReports, REPORTS_VIEW_CAPABILITY } from "@/lib/subscriptions/reports";
import { ReportsManager } from "./reports-manager";
import { PAGE_WRAP, PageHeader, PageMessage } from "@/app/academy/_shell/ui";

// PLAN.md line 807 / Item 32b: "/platform/reports (revenue breakdowns,
// expected vs. collected)." DESIGN.md's route table: "Entirely absent for
// platform_admin unless individually granted (and the revenue sub-view
// specifically is never grantable — §5)." Gated the same way as
// app/platform/usage/page.tsx: resolve AuthContext, redirect to /login if
// unauthenticated, hasPermission() check against the grantable
// "getPlatformReports" capability, calm access-denied message otherwise —
// this is the *page-level* gate (a platform_admin granted this capability
// can reach the page). The separate, ungrantable "platform.revenue.view"
// gate is enforced inside getPlatformReports() itself, independently of
// this check, and shows up here only as `result.data.revenue` being null —
// see lib/subscriptions/reports.ts's module comment.
export default async function PlatformReportsPage() {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const allowed = await hasPermission(context, REPORTS_VIEW_CAPABILITY);

  if (!allowed) {
    return <PageMessage title="Access denied" message="You don't have permission to view this page." />;
  }

  const result = await getPlatformReports(context);

  if (!result.ok) {
    // Unreachable in practice given the check above (same context, same
    // capability), but a calm fallback rather than a raw error/crash if
    // this ever gets out of sync (e.g. a grant revoked mid-request).
    return <PageMessage title="Access denied" message="You don't have permission to view this page." />;
  }

  return (
    <div className={PAGE_WRAP}>
      <PageHeader
        title="Reports"
        description="Revenue, academy growth and upcoming expiries."
      />
      <ReportsManager initialData={result.data} expiringCap={EXPIRING_SUBSCRIPTIONS_DEFAULT_LIMIT} />
    </div>
  );
}
