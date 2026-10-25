import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasPermission } from "@/lib/auth/permissions";
import { listAcademyUsageOverviewPage, USAGE_VIEW_CAPABILITY } from "@/lib/subscriptions/usage";
import { UsageManager } from "./usage-manager";
import { PAGE_WRAP, PageHeader, PageMessage } from "@/app/academy/_shell/ui";
import { PaginationNav } from "@/components/pagination-nav";
import { parsePageParam } from "@/lib/ui/pagination";

const PAGE_SIZE = 15;

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
export default async function PlatformUsagePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const allowed = await hasPermission(context, USAGE_VIEW_CAPABILITY);

  if (!allowed) {
    return <PageMessage title="Access denied" message="You don't have permission to view this page." />;
  }

  // Perf investigation (Afoogy slow-dashboard task): previously called
  // listAcademyUsageOverview() (every academy plus every subscription/
  // usage row platform-wide, reduced to "latest per academy" in JS) and
  // sliced the already-fetched array in JS. listAcademyUsageOverviewPage()
  // paginates the driving academies query in SQL and scopes the
  // subscription/usage lookups to just this page's academies.
  const params = await searchParams;
  const page = parsePageParam(params);
  const { rows, totalCount } = await listAcademyUsageOverviewPage(page, PAGE_SIZE);

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
      <PaginationNav page={page} pageSize={PAGE_SIZE} totalCount={totalCount} searchParams={params} />
    </div>
  );
}
