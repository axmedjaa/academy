import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { searchStudents } from "@/lib/academies/students";
import { getActiveCoursesForStudents } from "@/lib/academies/batch-assignments";
import { listBatches } from "@/lib/academies/batches";
import { listCourses } from "@/lib/academies/courses";
import { StudentsList } from "./students-list";

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
      <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        <h1>{result.error.code === "blocked" ? "Access unavailable" : "Access denied"}</h1>
        <p>{result.error.message}</p>
      </main>
    );
  }

  const { data, canManage, membershipRole } = result;
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
    <main
      style={{
        maxWidth: 1100,
        margin: "2rem auto",
        fontFamily: "system-ui, sans-serif",
        padding: "0 1rem",
      }}
    >
      <h1>Students</h1>
      <p style={{ color: "#666", fontSize: "0.9rem" }}>
        {branchLimited
          ? "Showing students in your assigned branch(es) only."
          : canManage
            ? "You can search, view, and edit students across this academy."
            : "You can view every student in this academy (read-only)."}
      </p>

      <form
        method="get"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "0.75rem",
          alignItems: "flex-end",
          margin: "1.5rem 0",
        }}
      >
        <label>
          Search (name or student #)
          <input type="text" name="q" defaultValue={searchTerm} />
        </label>
        {!branchLimited && (
          <label>
            Branch ID
            <input type="text" name="branchId" defaultValue={branchId} />
          </label>
        )}
        <label>
          Status
          <select name="status" defaultValue={status}>
            <option value="">Any</option>
            <option value="active">Active</option>
            <option value="archived">Archived</option>
          </select>
        </label>
        <button type="submit">Search</button>
      </form>

      <StudentsList
        students={data.rows}
        canManage={canManage}
        showBranchField={!branchLimited}
        coursesByStudent={coursesByStudent}
        courseOptions={courseOptions}
      />

      <p style={{ marginTop: "1rem" }}>
        Page {data.page} — {data.totalCount} total
        {data.totalCount > data.pageSize && (
          <>
            {" "}
            (
            {data.page > 1 && (
              <a
                href={`?${new URLSearchParams({ ...paramsToRecord(params), page: String(data.page - 1) }).toString()}`}
              >
                Previous
              </a>
            )}
            {data.page > 1 && data.page * data.pageSize < data.totalCount && " | "}
            {data.page * data.pageSize < data.totalCount && (
              <a
                href={`?${new URLSearchParams({ ...paramsToRecord(params), page: String(data.page + 1) }).toString()}`}
              >
                Next
              </a>
            )}
            )
          </>
        )}
      </p>
    </main>
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
