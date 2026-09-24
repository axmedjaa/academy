import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getAdmissionsView } from "@/lib/academies/students";
import { AdmissionsList } from "./admissions-list";
import { Button, PAGE_WRAP, PageHeader, PageMessage, Toolbar, inputClass } from "@/app/academy/_shell/ui";

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

  return (
    <div className={PAGE_WRAP}>
      <PageHeader
        title="Admissions"
        description={
          branchLimited
            ? "Showing recently-registered or pending-documents students in your assigned branch(es) only."
            : "Recently-registered or pending-documents students across this academy."
        }
      />

      {!branchLimited && (
        <form method="get">
          <Toolbar>
            <label className="min-w-[160px]">
              <span className="mb-1 block text-xs font-medium text-muted">Branch ID</span>
              <input type="text" name="branchId" defaultValue={branchId} className={inputClass} />
            </label>
            <Button type="submit" variant="secondary">
              Filter
            </Button>
          </Toolbar>
        </form>
      )}

      <AdmissionsList admissions={data.rows} canManage={canManage} />

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
