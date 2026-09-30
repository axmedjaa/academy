import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { searchStudents } from "@/lib/academies/students";
import { getActiveCoursesForStudents } from "@/lib/academies/batch-assignments";
import { canManageFeePeriodPayments, getStudentPaymentSummaries } from "@/lib/academies/fee-periods";
import { listBatches } from "@/lib/academies/batches";
import { listCourses } from "@/lib/academies/courses";
import { ACADEMY_FEE_PERIODS_ACTION, getAcademyPermissionLevel } from "@/lib/auth/academy-permissions";
import { StudentsList } from "./students-list";
import { Button, LinkButton, PAGE_WRAP, PageHeader, PageMessage, Section, inputClass } from "@/app/academy/_shell/ui";
import { Icon } from "@/app/academy/_shell/icons";
import { PaginationNav } from "@/components/pagination-nav";

/**
 * PLAN.md Item 39: `/academy/students` — student search/update.
 *
 * Same shape as app/academy/branches/page.tsx (Item 34): the `/academy/*`
 * layout (Item 28) already ran a base subscription/membership check, but
 * has no channel to hand this page the resolved academyId/role, so this
 * page's own read (`searchStudents`) repeats a
 * `checkAcademyAccessForContext`-backed lookup itself (inside
 * lib/academies/students.ts, not duplicated here).
 *
 * Filter/pagination UI follows app/academy/audit-logs/page.tsx's
 * GET-query-param convention (plain <form method="get">, re-navigate,
 * server-render): `q` (name/student-number search term), `branchId`,
 * `status`, `page`.
 */
export default async function AcademyStudentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const params = await searchParams;
  const get = (key: string): string => {
    const value = params[key];
    return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
  };

  const searchTerm = get("q");
  const branchId = get("branchId");
  const status = get("status");
  const pageParam = Number.parseInt(get("page"), 10);
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;

  const result = await searchStudents(
    context,
    {
      searchTerm: searchTerm || undefined,
      branchId: branchId || undefined,
      status: status === "active" || status === "archived" ? status : undefined,
    },
    { page },
  );

  if (!result.ok) {
    return (
      <PageMessage
        title={result.error.code === "blocked" ? "Access unavailable" : "Access denied"}
        message={result.error.message}
      />
    );
  }

  const { data, canManage, canDelete, membershipRole } = result;
  const branchLimited = membershipRole === "admissions_officer" || membershipRole === "trainer";
  // Student *visibility* is no longer branch-based for either role (see
  // lib/academies/students.ts's resolveScope): Admissions Officer sees
  // every student in the academy, Trainer sees students enrolled in the
  // courses/batches they teach. `branchLimited` above is intentionally left
  // as-is — it still correctly governs the unrelated branch-transfer
  // restriction (`showBranchField` below) — only this page's own
  // description text needed correcting to stop describing the old,
  // no-longer-true branch-based restriction.
  const isTrainer = membershipRole === "trainer";

  // Display enrichment for the "Course" column + "change course" control —
  // same "page re-resolves its own academyId, no channel exists to receive
  // it from searchStudents" reasoning as this file's own module comment.
  // Best-effort: on any failure, the course column/control simply doesn't
  // populate rather than failing the whole page.
  const access = await checkAcademyAccessForContext(context);
  const academyId = access.level !== "blocked" ? access.academyId : null;
  // Independent of `canManage` above (that's ACADEMY_STUDENTS_ACTION's edit
  // gate) — this is ACADEMY_FEE_PERIODS_ACTION's own "manage" gate, the same
  // permission recordFeePeriodPayment itself requires. A Finance Officer,
  // for example, has "view" on students but "manage" on fee periods, and
  // must still see the Students-list Record Payment action.
  const canManagePayments =
    access.level !== "blocked" &&
    canManageFeePeriodPayments(getAcademyPermissionLevel(access.membershipRole, ACADEMY_FEE_PERIODS_ACTION));

  const [coursesByStudent, paymentSummaries, batchesResult, coursesResult] = academyId
    ? await Promise.all([
        getActiveCoursesForStudents(academyId, data.rows.map((s) => s.id)),
        getStudentPaymentSummaries(academyId, data.rows.map((s) => s.id)),
        listBatches(context),
        listCourses(context),
      ])
    : [new Map(), new Map(), null, null];

  const courseNameById = new Map((coursesResult?.ok ? coursesResult.courses : []).map((c) => [c.id, c.name]));
  const courseOptions = (batchesResult?.ok ? batchesResult.batches : [])
    .filter((batch) => batch.status !== "archived")
    .map((batch) => ({
      batchId: batch.id,
      label: `${courseNameById.get(batch.courseId) ?? "Unknown course"} — ${batch.name}`,
    }));

  return (
    <div className={PAGE_WRAP}>
      <PageHeader
        title="Students"
        description={
          isTrainer
            ? "Showing students enrolled in the courses or batches you teach."
            : canManage
              ? "You can search, view, and edit students across this academy."
              : "You can view every student in this academy (read-only)."
        }
        actions={canManage ? <LinkButton href="/academy/students/new">Register student</LinkButton> : undefined}
      />

      <Section className="mb-6">
        <form method="get">
          <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-[240px] flex-1">
              <span className="mb-1 block text-xs font-medium text-muted">Search</span>
              <div className="relative">
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted">
                  <Icon name="search" width={16} height={16} />
                </span>
                <input
                  type="text"
                  name="q"
                  defaultValue={searchTerm}
                  placeholder="Name or student number"
                  className={`${inputClass} pl-9`}
                />
              </div>
            </label>
            {!branchLimited && (
              <label className="min-w-[160px]">
                <span className="mb-1 block text-xs font-medium text-muted">Branch ID</span>
                <input type="text" name="branchId" defaultValue={branchId} className={inputClass} />
              </label>
            )}
            <label className="min-w-[140px]">
              <span className="mb-1 block text-xs font-medium text-muted">Status</span>
              <select name="status" defaultValue={status} className={inputClass}>
                <option value="">Any status</option>
                <option value="active">Active</option>
                <option value="archived">Archived</option>
              </select>
            </label>
            <div className="flex gap-2">
              <Button type="submit" variant="secondary">
                Search
              </Button>
              {(searchTerm || branchId || status) && (
                <LinkButton href="/academy/students" variant="ghost">
                  Clear
                </LinkButton>
              )}
            </div>
          </div>
        </form>
      </Section>

      <StudentsList
        students={data.rows}
        canManage={canManage}
        canDelete={canDelete}
        canManagePayments={canManagePayments}
        showBranchField={!branchLimited}
        coursesByStudent={coursesByStudent}
        paymentSummaries={paymentSummaries}
        courseOptions={courseOptions}
      />

      <PaginationNav page={data.page} pageSize={data.pageSize} totalCount={data.totalCount} searchParams={params} />
    </div>
  );
}
