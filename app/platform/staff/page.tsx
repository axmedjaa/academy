import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasPermission, UNGRANTABLE_CAPABILITIES } from "@/lib/auth/permissions";
import { listPlatformStaff } from "@/lib/platform-staff/staff";
import { PlatformStaffManager } from "./platform-staff-manager";
import { PAGE_WRAP, PageHeader, PageMessage } from "@/app/academy/_shell/ui";

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
    return <PageMessage title="Access denied" message="You don't have permission to view this page." />;
  }

  const staff = await listPlatformStaff();

  return (
    <div className={PAGE_WRAP}>
      <PageHeader
        title="Platform staff"
        description="Create platform_admin accounts and grant them individual capabilities."
      />
      <PlatformStaffManager
        staff={staff}
        ungrantableCapabilities={[...UNGRANTABLE_CAPABILITIES]}
      />
    </div>
  );
}
