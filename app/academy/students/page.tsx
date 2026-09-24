import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { searchStudents } from "@/lib/academies/students";
import { getActiveCoursesForStudents } from "@/lib/academies/batch-assignments";
import { listBatches } from "@/lib/academies/batches";
import { listCourses } from "@/lib/academies/courses";
import { StudentsList } from "./students-list";
import { Button, LinkButton, PAGE_WRAP, PageHeader, PageMessage, Toolbar, inputClass } from "@/app/academy/_shell/ui";

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

  // Display enrichment for the "Course" column + "change course" control —
  // same "page re-resolves its own academyId, no channel exists to receive
  // it from searchStudents" reasoning as this file's own module comment.
  // Best-effort: on any failure, the course column/control simply doesn't
  // populate rather than failing the whole page.
  const access = await checkAcademyAccessForContext(context);
  const academyId = access.level !== "blocked" ? access.academyId : null;

  const [coursesByStudent, batchesResult, coursesResult] = academyId
    ? await Promise.all([
        getActiveCoursesForStudents(academyId, data.rows.map((s) => s.id)),
        listBatches(context),
        listCourses(context),
      ])
    : [new Map(), null, null];

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
          branchLimited
            ? "Showing students in your assigned branch(es) only."
            : canManage
              ? "You can search, view, and edit students across this academy."
              : "You can view every student in this academy (read-only)."
        }
        actions={canManage ? <LinkButton href="/academy/students/new">Register student</LinkButton> : undefined}
      />

      <form method="get">
        <Toolbar>
          <label className="min-w-[220px] flex-1">
            <span className="mb-1 block text-xs font-medium text-muted">Search (name or student #)</span>
            <input type="text" name="q" defaultValue={searchTerm} className={inputClass} />
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
              <option value="">Any</option>
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </Toolbar>
      </form>

      <StudentsList
        students={data.rows}
        canManage={canManage}
        canDelete={canDelete}
        showBranchField={!branchLimited}
        coursesByStudent={coursesByStudent}
        courseOptions={courseOptions}
      />

      <p className="mt-4 text-sm text-muted">
        Page {data.page} — {data.totalCount} total
        {data.totalCount > data.pageSize && (
          <>
            {" "}
            (
            {data.page > 1 && (
              <a
                href={`?${new URLSearchParams({ ...paramsToRecord(params), page: String(data.page - 1) }).toString()}`}
                className="text-brand hover:underline"
              >
                Previous
              </a>
            )}
            {data.page > 1 && data.page * data.pageSize < data.totalCount && " | "}
            {data.page * data.pageSize < data.totalCount && (
              <a
                href={`?${new URLSearchParams({ ...paramsToRecord(params), page: String(data.page + 1) }).toString()}`}
                className="text-brand hover:underline"
              >
                Next
              </a>
            )}
            )
          </>
        )}
      </p>
    </div>
  );
}

function paramsToRecord(
  params: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === "page") continue;
    const v = Array.isArray(value) ? value[0] : value;
    if (v) record[key] = v;
  }
  return record;
}
