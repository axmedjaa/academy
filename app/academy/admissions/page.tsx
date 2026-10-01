import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getAdmissionsView } from "@/lib/academies/students";
import { listBranches } from "@/lib/academies/branches";
import { AdmissionsList } from "./admissions-list";
import { Button, LinkButton, PAGE_WRAP, PageHeader, PageMessage, Toolbar, inputClass } from "@/app/academy/_shell/ui";
import { PaginationNav } from "@/components/pagination-nav";

/**
 * PLAN.md Item 39: `/academy/admissions` — admissions view, distinct from
 * the plain `/academy/students` list.
 *
 * DESIGN.md §9.2 sketches this as a board/pipeline view (Applied ->
 * Documents Pending -> Enrolled) that the current `students` schema (Item
 * 37, no pipeline-stage column) can't literally support — see
 * lib/academies/students.ts's `getAdmissionsView` doc comment for the full
 * judgment call. In short: this page shows only *active* students who are
 * either recently registered or still missing documents (the two
 * conditions this schema can actually express), newest first, each row
 * flagged with `hasDocuments`/`daysSinceRegistered` so the table can badge
 * "Documents pending" / "Recently applied" — a settled, fully-documented,
 * not-recent student is left off this view (they're still on the plain
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

  return (
    <div className={PAGE_WRAP}>
      <PageHeader
        title="Admissions"
        description={
          isTrainer
            ? "Showing recently-registered or pending-documents students enrolled in the courses or batches you teach."
            : "Recently-registered or pending-documents students across this academy."
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

      <AdmissionsList admissions={data.rows} canManage={canManage} />

      <PaginationNav page={data.page} pageSize={data.pageSize} totalCount={data.totalCount} searchParams={params} />
    </div>
  );
}
