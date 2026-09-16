import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasPermission } from "@/lib/auth/permissions";
import { listSubscriptionPlans } from "@/lib/subscriptions/plans";
import { PlansManager } from "./plans-manager";

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
    return (
      <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        <h1>Access denied</h1>
        <p>You don&apos;t have permission to view this page.</p>
      </main>
    );
  }

  const plans = await listSubscriptionPlans();

  return (
    <main
      style={{
        maxWidth: 900,
        margin: "2rem auto",
        fontFamily: "system-ui, sans-serif",
        padding: "0 1rem",
      }}
    >
      <h1>Subscription plans</h1>
      <PlansManager plans={plans} />
    </main>
  );
}
