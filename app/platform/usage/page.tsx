import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasPermission } from "@/lib/auth/permissions";
import { listAcademyUsageOverview, USAGE_VIEW_CAPABILITY } from "@/lib/subscriptions/usage";
import { UsageManager } from "./usage-manager";
import { PAGE_WRAP, PageHeader, PageMessage } from "@/app/academy/_shell/ui";

// PLAN.md Item 29 / DESIGN.md §7: "/platform/usage | A | Per-academy usage
// bars vs. plan limits; over-limit rows visually flagged even though this
// view is informational (enforcement happens at creation time, not here)."
// Gated the same way as app/platform/staff/page.tsx: resolve AuthContext,
// redirect to /login if unauthenticated, hasPermission() check, calm
// access-denied message otherwise. Unlike /platform/staff (ungrantable),
// this capability ("getPlatformReports") IS grantable — see
// lib/subscriptions/usage.ts's module comment for why usage viewing reuses
// that capability rather than a new one PLAN.md never names — so a
// platform_admin granted it can reach this page too, not only
// platform_owner.
export default async function PlatformUsagePage() {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const allowed = await hasPermission(context, USAGE_VIEW_CAPABILITY);

  if (!allowed) {
    return <PageMessage title="Access denied" message="You don't have permission to view this page." />;
  }

  const rows = await listAcademyUsageOverview();

  return (
    <div className={PAGE_WRAP}>
      <PageHeader
        title="Usage & Allowances"
        description={
          <>
            Per-academy usage vs. plan limits. This view is informational — allowance is
            enforced server-side at the moment a branch/staff/student/course/storage-upload
            is created, not here. Figures reflect the last time &quot;Recalculate&quot; was
            run for that academy.
          </>
        }
      />
      <UsageManager rows={rows} />
    </div>
  );
}
