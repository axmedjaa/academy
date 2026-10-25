import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasPermission } from "@/lib/auth/permissions";
import { listSubscriptionPlansPage } from "@/lib/subscriptions/plans";
import { PlansManager } from "./plans-manager";
import { PAGE_WRAP, PageHeader, PageMessage } from "@/app/academy/_shell/ui";
import { PaginationNav } from "@/components/pagination-nav";
import { parsePageParam } from "@/lib/ui/pagination";

const PLANS_MANAGE_CAPABILITY = "plans.manage";
const PAGE_SIZE = 15;

// PLAN.md Item 22 / DESIGN.md §8: "/platform/plans... Entirely absent for
// platform_admin regardless of grants (§5)." Gated exactly like
// app/platform/staff/page.tsx (Item 31): resolve AuthContext, redirect to
// /login if unauthenticated, hasPermission() check, calm access-denied
// message otherwise (never a raw error page). Because "plans.manage" is in
// UNGRANTABLE_CAPABILITIES (lib/auth/permissions.ts), hasPermission()
// returns true here only for platform_owner — no platform_admin grant can
// ever satisfy it, which is exactly the "absent regardless of any grant"
// requirement.
export default async function PlatformPlansPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const allowed = await hasPermission(context, PLANS_MANAGE_CAPABILITY);

  if (!allowed) {
    return <PageMessage title="Access denied" message="You don't have permission to view this page." />;
  }

  // Perf investigation (Afoogy slow-dashboard task): previously called
  // listSubscriptionPlans() (every row, no DB-level LIMIT/OFFSET) and
  // sliced the already-fetched array in JS — harmless at a handful of
  // rows, but that function's own unbounded SELECT means every load of
  // this page shipped the *entire* subscription_plans table across the
  // wire first. listSubscriptionPlansPage() pushes LIMIT/OFFSET and the
  // page-nav total down to Postgres instead; listSubscriptionPlans()
  // itself is untouched for its other caller (the academy registration
  // plan picker, which still needs every row).
  const params = await searchParams;
  const page = parsePageParam(params);
  const { plans, totalCount } = await listSubscriptionPlansPage(page, PAGE_SIZE);

  return (
    <div className={PAGE_WRAP}>
      <PageHeader title="Subscription plans" />
      <PlansManager plans={plans} />
      <PaginationNav page={page} pageSize={PAGE_SIZE} totalCount={totalCount} searchParams={params} />
    </div>
  );
}
