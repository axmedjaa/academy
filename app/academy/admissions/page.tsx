import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getAdmissionsView, getStudentPhotoUrl } from "@/lib/academies/students";
import { listBranches } from "@/lib/academies/branches";
import { listBatches } from "@/lib/academies/batches";
import { listCourses } from "@/lib/academies/courses";
import { AdmissionsList } from "./admissions-list";
import { Button, LinkButton, PAGE_WRAP, PageHeader, PageMessage, Toolbar, inputClass } from "@/app/academy/_shell/ui";
import { PaginationNav } from "@/components/pagination-nav";

/**
 * PLAN.md Item 39: `/academy/admissions` — admissions view, distinct from
 * the plain `/academy/students` list.
 *
 * DESIGN.md §9.2 sketches this as a board/pipeline view (Applied ->
 * Documents Pending -> Enrolled) that the current `students` schema (Item
 * 37, no pipeline-stage column) can't literally support. Post-audit
 * revision (see lib/academies/students.ts's `getAdmissionsView` doc
 * comment for the full "why"): the Documents-Pending stand-in this used to
 * use was never a real, reachable signal (nothing in this codebase ever
 * creates a `student_documents` row), so it's been replaced with the one
 * distinction that actually has real data behind it — enrollment. This
 * page now shows only *active* students with NO active `batch_enrollments`
 * row ("Applied"), newest first; the moment a student is enrolled in a
 * batch, they drop off this view entirely (they're still on the plain
 * list). Same gating as `/academy/students` (one Master Permission Matrix
 * row covers both).
 */
export default async function AcademyAdmissionsPage({
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

  const branchId = get("branchId");
  const pageParam = Number.parseInt(get("page"), 10);
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;

  const result = await getAdmissionsView(context, { branchId: branchId || undefined }, { page });

  if (!result.ok) {
    return (
      <PageMessage
        title={result.error.code === "blocked" ? "Access unavailable" : "Access denied"}
        message={result.error.message}
      />
    );
  }

  const { data, canManage, membershipRole } = result;
  const branchLimited = membershipRole === "admissions_officer" || membershipRole === "trainer";
  // Same visibility-model correction as app/academy/students/page.tsx: this
  // view reads from getAdmissionsView, which shares students.ts's
  // resolveScope — Admissions Officer sees the whole academy, Trainer sees
  // only students enrolled in courses/batches they teach. `branchLimited`
  // is left as-is for the (unrelated) Branch filter field below.
  const isTrainer = membershipRole === "trainer";

  // Branch options for the filter select below — same already-established
  // convention as app/academy/batches/page.tsx's own branch dropdown.
  // listBranches applies its own scoping, but the filter row only renders
  // for !branchLimited roles anyway, so this is always the full academy
  // list in practice here.
  const branchesResult = !branchLimited ? await listBranches(context) : null;
  const branchOptions = branchesResult?.ok ? branchesResult.branches : [];

  // Same server-side signed-URL resolution as app/academy/students/page.tsx
  // — a student's real photo only ever reaches the browser as a
  // short-lived signed GET, never the raw profileImageRef object key.
  const photoEntries = await Promise.all(
    data.rows
      .filter((row) => row.profileImageRef)
      .map(async (row) => {
        const url = await getStudentPhotoUrl(row.profileImageRef);
        return url ? ([row.id, url] as const) : null;
      }),
  );
  const photoUrlByStudentId = new Map(photoEntries.filter((entry): entry is readonly [string, string] => entry !== null));

  // Course/batch picker for the new "Enroll" action below — the exact same
  // computation app/academy/students/page.tsx already does for its own
  // "change course" dialog (listBatches already applies the caller's own
  // scoping — branch-limited roles only ever see their own batches — so
  // this never offers a batch the actor couldn't actually enroll into).
  // `canEnroll` reuses listBatches' own `canManage` (ACADEMY_COURSES_
  // BATCHES_ACTION's "full"/"manage" gate — the exact permission
  // enrollStudentInBatch itself checks), rather than re-deriving a second
  // copy of that permission decision here.
  const [batchesResult, coursesResult] = await Promise.all([listBatches(context), listCourses(context)]);
  const courseNameById = new Map((coursesResult.ok ? coursesResult.courses : []).map((c) => [c.id, c.name]));
  const courseOptions = (batchesResult.ok ? batchesResult.batches : [])
    .filter((batch) => batch.status !== "archived")
    .map((batch) => ({
      batchId: batch.id,
      label: `${courseNameById.get(batch.courseId) ?? "Unknown course"} — ${batch.name}`,
    }));
  const canEnroll = batchesResult.ok && batchesResult.canManage;

  return (
    <div className={PAGE_WRAP}>
      <PageHeader
        title="Admissions"
        description={
          isTrainer
            ? "Applied students not yet enrolled in the courses or batches you teach."
            : "Applied students across this academy who are not yet enrolled in a batch."
        }
      />

      {!branchLimited && (
        <form method="get">
          <Toolbar>
            <label className="min-w-[200px]">
              <span className="mb-1 block text-xs font-medium text-muted">Branch</span>
              <select name="branchId" defaultValue={branchId} className={inputClass}>
                <option value="">All branches</option>
                {branchOptions.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-2">
              <Button type="submit" variant="secondary">
                Filter
              </Button>
              {branchId && (
                <LinkButton href="/academy/admissions" variant="ghost">
                  Clear
                </LinkButton>
              )}
            </div>
          </Toolbar>
        </form>
      )}

      <AdmissionsList
        admissions={data.rows}
        canManage={canManage}
        canEnroll={canEnroll}
        courseOptions={courseOptions}
        photoUrlByStudentId={photoUrlByStudentId}
      />

      <PaginationNav page={data.page} pageSize={data.pageSize} totalCount={data.totalCount} searchParams={params} />
    </div>
  );
}
