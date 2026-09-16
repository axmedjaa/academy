import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasPermission } from "@/lib/auth/permissions";
import { listSubscriptionPlans } from "@/lib/subscriptions/plans";
import { RegisterAcademyForm } from "./register-academy-form";

const REGISTER_ACADEMY_CAPABILITY = "registerAcademy";

// PLAN.md Item 20 / DESIGN.md §8: "/platform/academies/new". "registerAcademy"
// is in UNGRANTABLE_CAPABILITIES (lib/auth/permissions.ts), so hasPermission()
// only ever returns true here for platform_owner — no platform_admin grant
// can satisfy it. Gated the same way as every other platform page (Phase 0
// Item 12 / app/platform/staff/page.tsx): resolve AuthContext, redirect to
// /login if unauthenticated, hasPermission() check, calm access-denied
// message otherwise (never a raw error page).
export default async function RegisterAcademyPage() {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const allowed = await hasPermission(context, REGISTER_ACADEMY_CAPABILITY);

  if (!allowed) {
    return (
      <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        <h1>Access denied</h1>
        <p>You don&apos;t have permission to view this page.</p>
      </main>
    );
  }

  // Item 24: registration now assigns a plan and creates the initial
  // academy_subscriptions row itself (createAcademySubscription), so the
  // wizard needs the selectable plan list up front — "only active plans
  // should be selectable at registration time" (retired plans are filtered
  // out here rather than in the form, matching listSubscriptionPlans()'s own
  // "callers must already have checked permission" convention: this page's
  // registerAcademy gate is platform_owner-only, at least as strict as
  // plans.manage, so no separate permission check is needed to read them).
  const plans = await listSubscriptionPlans();
  const activePlans = plans.filter((plan) => plan.isActive);

  return (
    <main
      style={{
        maxWidth: 720,
        margin: "2rem auto",
        fontFamily: "system-ui, sans-serif",
        padding: "0 1rem",
      }}
    >
      <h1>Register a new academy</h1>
      <p style={{ color: "#555" }}>
        Creates the academy profile, its owner account, a default branch, and
        its initial subscription in one step.
      </p>
      <RegisterAcademyForm activePlans={activePlans} />
    </main>
  );
}
