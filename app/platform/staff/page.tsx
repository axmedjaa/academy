import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasPermission, UNGRANTABLE_CAPABILITIES } from "@/lib/auth/permissions";
import { listPlatformStaff } from "@/lib/platform-staff/staff";
import { PlatformStaffManager } from "./platform-staff-manager";

const STAFF_MANAGE_CAPABILITY = "platform.staff.manage";

// PLAN.md Item 31 / DESIGN.md §8: "/platform/staff... visible and usable by
// platform_owner only — absent entirely from every platform_admin's nav and
// every direct URL, regardless of any grant". Gated the same way as
// app/protected/page.tsx (Phase 0 Item 12): resolve AuthContext, redirect to
// /login if unauthenticated, hasPermission() check, calm access-denied
// message otherwise (never a raw error page). Because
// "platform.staff.manage" is in UNGRANTABLE_CAPABILITIES, hasPermission()
// returns true here only for platform_owner — no platform_admin grant can
// ever satisfy it, which is exactly the "absent regardless of any grant"
// requirement.
export default async function PlatformStaffPage() {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const allowed = await hasPermission(context, STAFF_MANAGE_CAPABILITY);

  if (!allowed) {
    return (
      <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        <h1>Access denied</h1>
        <p>You don&apos;t have permission to view this page.</p>
      </main>
    );
  }

  const staff = await listPlatformStaff();

  return (
    <main
      style={{
        maxWidth: 900,
        margin: "2rem auto",
        fontFamily: "system-ui, sans-serif",
        padding: "0 1rem",
      }}
    >
      <h1>Platform staff</h1>
      <PlatformStaffManager
        staff={staff}
        ungrantableCapabilities={[...UNGRANTABLE_CAPABILITIES]}
      />
    </main>
  );
}
