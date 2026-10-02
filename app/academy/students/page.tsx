import { redirect } from "next/navigation";
import Link from "next/link";
import { getAuthContext } from "@/lib/auth/auth-context";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { getStudentPhotoUrl, searchStudents } from "@/lib/academies/students";
import { getActiveCoursesForStudents } from "@/lib/academies/batch-assignments";
import { canManageFeePeriodPayments, getStudentPaymentSummaries } from "@/lib/academies/fee-periods";
import { listBatches } from "@/lib/academies/batches";
import { listCourses } from "@/lib/academies/courses";
import { listBranches } from "@/lib/academies/branches";
import { ACADEMY_FEE_PERIODS_ACTION, getAcademyPermissionLevel } from "@/lib/auth/academy-permissions";
import { StudentsList } from "./students-list";
import { Button, LinkButton, PAGE_WRAP, PageHeader, PageMessage, inputClass } from "@/app/academy/_shell/ui";
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
 *
 * Redesign pass (Impeccable audit): the filter form and the table used to
 * be two separately bordered/shadowed boxes — now the filter row renders
 * as the top strip of the SAME bordered surface the table lives in (see
 * students-list.tsx's `filterBar` prop), with a hairline divider between
 * them instead of a second card. This page still owns the filter form
 * itself (it needs `searchParams`/`branchLimited`) and passes it down as a
 * server-rendered `ReactNode` — no interactivity added, no new data
 * fetched. A context line ("N students[, match your filters]") is now
 * folded into the header description so the page always shows scale, even
 * when there's only one page of results (PaginationNav renders nothing in
 * that case, so this was previously the ONLY place total count ever
 * appeared, and only when there were 2+ pages). Active filters now render
 * as small removable chips (DESIGN.md §3's "active filters as removable
 * chips", previously unimplemented) — each just a plain link to the same
 * URL with that one param stripped, mirroring PaginationNav's own
 * `buildPageHref` normalization.
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

  // Branch options for the filter select below — same established
  // convention as app/academy/admissions/page.tsx's own branch dropdown
  // (itself following app/academy/batches/page.tsx's create-form branch
  // select). listBranches applies its own scoping, but the filter field
  // only renders for !branchLimited roles anyway, so this is always the
  // full academy list in practice here.
  const branchesResult = !branchLimited ? await listBranches(context) : null;
  const branchOptions = branchesResult?.ok ? branchesResult.branches : [];
  const branchNameById = new Map(branchOptions.map((branch) => [branch.id, branch.name]));

  const hasActiveFilters = Boolean(searchTerm || branchId || status);
  const countLabel =
    data.totalCount === 0
      ? hasActiveFilters
        ? "No students match your filters"
        : "No students yet"
      : `${data.totalCount} student${data.totalCount === 1 ? "" : "s"}${hasActiveFilters ? " match your filters" : ""}`;

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

  // Resolves each photo-having student's `profileImageRef` (an R2 object
  // key) into a short-lived signed GET url — must happen server-side
  // (getStudentPhotoUrl needs R2 credentials the browser never sees).
  // `getSignedUrl` is a local HMAC computation, not a network call, so
  // resolving one per student here is cheap even at this page's page
  // size. A student whose resolution fails (R2 unreachable) or who has no
  // photo simply has no entry — StudentAvatar's own initials fallback
  // covers that.
  const photoEntries = await Promise.all(
    data.rows
      .filter((student) => student.profileImageRef)
      .map(async (student) => {
        const url = await getStudentPhotoUrl(student.profileImageRef);
        return url ? ([student.id, url] as const) : null;
      }),
  );
  const photoUrlByStudentId = new Map(photoEntries.filter((entry): entry is readonly [string, string] => entry !== null));

  const courseNameById = new Map((coursesResult?.ok ? coursesResult.courses : []).map((c) => [c.id, c.name]));
  const courseOptions = (batchesResult?.ok ? batchesResult.batches : [])
    .filter((batch) => batch.status !== "archived")
    .map((batch) => ({
      batchId: batch.id,
      label: `${courseNameById.get(batch.courseId) ?? "Unknown course"} — ${batch.name}`,
    }));

  // Removable filter chips — plain links to this same URL with exactly one
  // param stripped (and `page` always dropped, same as PaginationNav's own
  // buildPageHref: a filter change always returns to page 1). No new data;
  // just a presentation of the params already being read above.
  function hrefWithout(keyToRemove: string): string {
    const record: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
      if (key === keyToRemove || key === "page") continue;
      const v = Array.isArray(value) ? value[0] : value;
      if (v) record[key] = v;
    }
    const query = new URLSearchParams(record).toString();
    return query ? `/academy/students?${query}` : "/academy/students";
  }

  const chips: { key: string; label: string; href: string }[] = [];
  if (searchTerm) chips.push({ key: "q", label: `Search: "${searchTerm}"`, href: hrefWithout("q") });
  if (status) {
    chips.push({ key: "status", label: `Status: ${status === "active" ? "Active" : "Archived"}`, href: hrefWithout("status") });
  }
  if (branchId && !branchLimited) {
    chips.push({ key: "branchId", label: `Branch: ${branchNameById.get(branchId) ?? branchId}`, href: hrefWithout("branchId") });
  }

  const filterBar = (
    <div className="border-b border-border p-5">
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
          <label className="min-w-[140px]">
            <span className="mb-1 block text-xs font-medium text-muted">Status</span>
            <select name="status" defaultValue={status} className={inputClass}>
              <option value="">Any status</option>
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          {!branchLimited && (
            // Same branch-name select as app/academy/admissions/page.tsx's
            // own filter — `name="branchId"` still submits the branch's id
            // as the query param value, so filtering/URL semantics are
            // unchanged from the old raw-ID text input; only the control
            // itself (and what the user sees/picks) changed.
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
          )}
          <div className="flex gap-2">
            <Button type="submit" variant="secondary">
              Search
            </Button>
            {hasActiveFilters && (
              <LinkButton href="/academy/students" variant="ghost">
                Clear
              </LinkButton>
            )}
          </div>
        </div>
      </form>
      {chips.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {chips.map((chip) => (
            <Link
              key={chip.key}
              href={chip.href}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-app px-2.5 py-1 text-xs font-medium text-ink no-underline transition-colors duration-150 hover:bg-border/60 motion-safe:active:scale-[0.98]"
            >
              {chip.label}
              <Icon name="close" width={12} height={12} />
            </Link>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className={PAGE_WRAP}>
      <PageHeader
        title="Students"
        description={
          <>
            <span className="font-medium text-ink">{countLabel}</span>
            {" — "}
            {isTrainer
              ? "showing students enrolled in the courses or batches you teach."
              : canManage
                ? "you can search, view, and edit students across this academy."
                : "you can view every student in this academy (read-only)."}
          </>
        }
        actions={canManage ? <LinkButton href="/academy/students/new">Register student</LinkButton> : undefined}
      />

      <StudentsList
        students={data.rows}
        canManage={canManage}
        canDelete={canDelete}
        canManagePayments={canManagePayments}
        showBranchField={!branchLimited}
        coursesByStudent={coursesByStudent}
        photoUrlByStudentId={photoUrlByStudentId}
        paymentSummaries={paymentSummaries}
        courseOptions={courseOptions}
        filterBar={filterBar}
        hasActiveFilters={hasActiveFilters}
      />

      <PaginationNav page={data.page} pageSize={data.pageSize} totalCount={data.totalCount} searchParams={params} />
    </div>
  );
}
