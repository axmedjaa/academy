import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { ACADEMY_FEE_PERIODS_ACTION, getAcademyPermissionLevel, hasAcademyPermission } from "@/lib/auth/academy-permissions";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { searchStudents, STUDENTS_MAX_PAGE_SIZE } from "@/lib/academies/students";
import { PAGE_WRAP, PageHeader, PageMessage } from "@/app/academy/_shell/ui";
import { FeePeriodsManager } from "./fee-periods-manager";

/**
 * §12-27 — Student Fee Periods: monthly/quarterly/yearly schedules,
 * per-period paid/remaining/status, Record Payment (single or multi-period).
 * Gated on ACADEMY_FEE_PERIODS_ACTION (view-or-above); the manager's own
 * `canManage` prop (from the same access check) decides whether the
 * schedule/payment forms render.
 */
export default async function FeePeriodsPage() {
  const context = await getAuthContext();
  if (!context) {
    redirect("/login");
  }

  const access = await checkAcademyAccessForContext(context);
  if (access.level === "blocked") {
    return <PageMessage title="Access unavailable" message={access.message} />;
  }
  if (!hasAcademyPermission(access.membershipRole, ACADEMY_FEE_PERIODS_ACTION)) {
    return <PageMessage title="Access denied" message="You don't have permission to view this page." />;
  }
  // Mirrors fee-periods.ts's own canManage — this page only needs the
  // boolean, not the full permission-level plumbing.
  const permissionLevel = getAcademyPermissionLevel(access.membershipRole, ACADEMY_FEE_PERIODS_ACTION);
  const canManage = permissionLevel === "full" || permissionLevel === "manage";

  const studentPickerResult = await searchStudents(context, { status: "active" }, { pageSize: STUDENTS_MAX_PAGE_SIZE });
  const studentOptions = studentPickerResult.ok
    ? studentPickerResult.data.rows.map((row) => ({ id: row.id, fullName: row.fullName, studentNumber: row.studentNumber }))
    : [];

  return (
    <div className={PAGE_WRAP}>
      <PageHeader
        title="Fee Periods"
        description="Monthly, quarterly, or yearly fee schedules per enrollment — what each period is expected, paid, and remaining."
      />
      <FeePeriodsManager studentOptions={studentOptions} canManage={canManage} />
    </div>
  );
}
