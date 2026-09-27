import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasPermission, UNGRANTABLE_CAPABILITIES } from "@/lib/auth/permissions";
import { listPlatformStaff } from "@/lib/platform-staff/staff";
import { PlatformStaffManager } from "./platform-staff-manager";
import { PAGE_WRAP, PageHeader, PageMessage } from "@/app/academy/_shell/ui";
import { PaginationNav } from "@/components/pagination-nav";
import { parsePageParam } from "@/lib/ui/pagination";

const STAFF_MANAGE_CAPABILITY = "platform.staff.manage";
const PAGE_SIZE = 15;

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
export default async function PlatformStaffPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const allowed = await hasPermission(context, STAFF_MANAGE_CAPABILITY);

  if (!allowed) {
    return <PageMessage title="Access denied" message="You don't have permission to view this page." />;
  }

  // `listPlatformStaff()` is also used internally (lib/academies/approve.ts,
  // lib/subscriptions/plans.ts) — sliced here instead, after fetching, same
  // "still fully server-side" reasoning as app/platform/academies/page.tsx.
  const params = await searchParams;
  const page = parsePageParam(params);
  const allStaff = await listPlatformStaff();
  const totalCount = allStaff.length;
  const offset = (page - 1) * PAGE_SIZE;
  const staff = allStaff.slice(offset, offset + PAGE_SIZE);

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
      <PaginationNav page={page} pageSize={PAGE_SIZE} totalCount={totalCount} searchParams={params} />
    </div>
  );
}
