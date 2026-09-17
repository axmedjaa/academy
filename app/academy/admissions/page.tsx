import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getAdmissionsView } from "@/lib/academies/students";
import { AdmissionsList } from "./admissions-list";

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
      <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        <h1>{result.error.code === "blocked" ? "Access unavailable" : "Access denied"}</h1>
        <p>{result.error.message}</p>
      </main>
    );
  }

  const { data, canManage, membershipRole } = result;
  const branchLimited = membershipRole === "admissions_officer" || membershipRole === "trainer";

  return (
    <main
      style={{
        maxWidth: 1100,
        margin: "2rem auto",
        fontFamily: "system-ui, sans-serif",
        padding: "0 1rem",
      }}
    >
      <h1>Admissions</h1>
      <p style={{ color: "#666", fontSize: "0.9rem" }}>
        {branchLimited
          ? "Showing recently-registered or pending-documents students in your assigned branch(es) only."
          : "Recently-registered or pending-documents students across this academy."}
      </p>

      {!branchLimited && (
        <form
          method="get"
          style={{ display: "flex", gap: "0.75rem", alignItems: "flex-end", margin: "1.5rem 0" }}
        >
          <label>
            Branch ID
            <input type="text" name="branchId" defaultValue={branchId} />
          </label>
          <button type="submit">Filter</button>
        </form>
      )}

      <AdmissionsList admissions={data.rows} canManage={canManage} />

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
