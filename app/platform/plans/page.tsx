import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasPermission } from "@/lib/auth/permissions";
import { listSubscriptionPlans } from "@/lib/subscriptions/plans";
import { PlansManager } from "./plans-manager";
import { PAGE_WRAP, PageHeader, PageMessage } from "@/app/academy/_shell/ui";

const PLANS_MANAGE_CAPABILITY = "plans.manage";

// PLAN.md Item 22 / DESIGN.md §8: "/platform/plans... Entirely absent for
// platform_admin regardless of grants (§5)." Gated exactly like
// app/platform/staff/page.tsx (Item 31): resolve AuthContext, redirect to
// /login if unauthenticated, hasPermission() check, calm access-denied
// message otherwise (never a raw error page). Because "plans.manage" is in
// UNGRANTABLE_CAPABILITIES (lib/auth/permissions.ts), hasPermission()
// returns true here only for platform_owner — no platform_admin grant can
// ever satisfy it, which is exactly the "absent regardless of any grant"
// requirement.
export default async function PlatformPlansPage() {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const allowed = await hasPermission(context, PLANS_MANAGE_CAPABILITY);

  if (!allowed) {
    return <PageMessage title="Access denied" message="You don't have permission to view this page." />;
  }

  const plans = await listSubscriptionPlans();

  return (
    <div className={PAGE_WRAP}>
      <PageHeader title="Subscription plans" />
      <PlansManager plans={plans} />
    </div>
  );
}
