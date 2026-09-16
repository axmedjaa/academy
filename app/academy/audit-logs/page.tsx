import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getAuditLogsForOwnAcademy } from "@/lib/academies/audit-logs-actions";
import type { AuditResult } from "@/lib/audit-query";

/**
 * PLAN.md Item 42: `/academy/audit-logs`, Owner/Admin only, hard-scoped to
 * the caller's own academy. `app/academy/layout.tsx` (Item 28) already
 * gates the whole `/academy/*` subtree for base subscription access; the
 * Owner/Admin-only role gate on top of that lives in
 * `getAuditLogsForOwnAcademy` -> `getAcademyAuditLogs`
 * (lib/academies/audit-logs.ts), same "resolve access again inside the
 * action, don't thread state through the layout" precedent as
 * app/academy/settings/page.tsx.
 *
 * Filter/pagination UI follows app/platform/audit-logs/page.tsx's
 * GET-query-param convention (plain <form method="get">, re-navigate,
 * server-render) — the one difference is there is no "Academy ID" filter
 * field at all, since this route can only ever see its own academy's rows.
 */
export default async function AcademyAuditLogsPage({
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

  const actorRole = get("actorRole");
  const action = get("action");
  const branchId = get("branchId");
  const result = get("result");
  const createdFrom = get("createdFrom");
  const createdTo = get("createdTo");
  const pageParam = Number.parseInt(get("page"), 10);
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;

  const response = await getAuditLogsForOwnAcademy(
    {
      actorRole: actorRole || undefined,
      action: action || undefined,
      branchId: branchId || undefined,
      result: (result || undefined) as AuditResult | undefined,
      createdFrom: createdFrom ? new Date(createdFrom) : undefined,
      createdTo: createdTo ? new Date(createdTo) : undefined,
    },
    { page },
  );

  return (
    <main
      style={{
        maxWidth: 1100,
        margin: "2rem auto",
        fontFamily: "system-ui, sans-serif",
        padding: "0 1rem",
      }}
    >
      <h1>Academy audit log</h1>

      {!response.ok ? (
        <p role="alert" style={{ color: "crimson" }}>
          {response.error.message}
        </p>
      ) : (
        <>
          <form
            method="get"
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "0.75rem",
              alignItems: "flex-end",
              marginBottom: "1.5rem",
            }}
          >
            <label>
              Action
              <input type="text" name="action" defaultValue={action} />
            </label>
            <label>
              Actor role
              <input type="text" name="actorRole" defaultValue={actorRole} />
            </label>
            <label>
              Branch ID
              <input type="text" name="branchId" defaultValue={branchId} />
            </label>
            <label>
              Result
              <select name="result" defaultValue={result}>
                <option value="">Any</option>
                <option value="success">Success</option>
                <option value="failure">Failure</option>
              </select>
            </label>
            <label>
              From
              <input type="date" name="createdFrom" defaultValue={createdFrom} />
            </label>
            <label>
              To
              <input type="date" name="createdTo" defaultValue={createdTo} />
            </label>
            <button type="submit">Filter</button>
          </form>

          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>When</th>
                <th style={{ textAlign: "left" }}>Action</th>
                <th style={{ textAlign: "left" }}>Actor role</th>
                <th style={{ textAlign: "left" }}>Entity</th>
                <th style={{ textAlign: "left" }}>Result</th>
              </tr>
            </thead>
            <tbody>
              {response.data.rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.createdAt.toISOString()}</td>
                  <td>{row.action}</td>
                  <td>{row.actorRole ?? "—"}</td>
                  <td>{row.entityType}</td>
                  <td>{row.result}</td>
                </tr>
              ))}
              {response.data.rows.length === 0 && (
                <tr>
                  <td colSpan={5}>No audit log entries match these filters.</td>
                </tr>
              )}
            </tbody>
          </table>

          <p style={{ marginTop: "1rem" }}>
            Page {response.data.page} — {response.data.totalCount} total
            {response.data.totalCount > response.data.pageSize && (
              <>
                {" "}
                (
                {response.data.page > 1 && (
                  <a
                    href={`?${new URLSearchParams({ ...paramsToRecord(params), page: String(response.data.page - 1) }).toString()}`}
                  >
                    Previous
                  </a>
                )}
                {response.data.page > 1 &&
                  response.data.page * response.data.pageSize < response.data.totalCount &&
                  " | "}
                {response.data.page * response.data.pageSize < response.data.totalCount && (
                  <a
                    href={`?${new URLSearchParams({ ...paramsToRecord(params), page: String(response.data.page + 1) }).toString()}`}
                  >
                    Next
                  </a>
                )}
                )
              </>
            )}
          </p>
        </>
      )}
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
