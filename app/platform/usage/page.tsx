import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasPermission } from "@/lib/auth/permissions";
import { listAcademyUsageOverview, USAGE_VIEW_CAPABILITY } from "@/lib/subscriptions/usage";
import { UsageManager } from "./usage-manager";

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
    return (
      <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        <h1>Access denied</h1>
        <p>You don&apos;t have permission to view this page.</p>
      </main>
    );
  }

  const rows = await listAcademyUsageOverview();

  return (
    <main
      style={{
        maxWidth: 1000,
        margin: "2rem auto",
        fontFamily: "system-ui, sans-serif",
        padding: "0 1rem",
      }}
    >
      <h1>Usage &amp; Allowances</h1>
      <p style={{ color: "#555" }}>
        Per-academy usage vs. plan limits. This view is informational —
        allowance is enforced server-side at the moment a branch/staff/
        student/course/storage-upload is created, not here. Figures reflect
        the last time &quot;Recalculate&quot; was run for that academy.
      </p>
      <UsageManager rows={rows} />
    </main>
  );
}
