import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasPermission } from "@/lib/auth/permissions";
import { queryAuditLogs } from "@/lib/audit-query-actions";
import type { AuditResult } from "@/lib/audit-query";

const AUDIT_LOGS_CAPABILITY = "queryAuditLogs";

// PLAN.md Item 32 / DESIGN.md §8: platform audit log viewer. Gated the same
// way as app/platform/staff/page.tsx and app/protected/page.tsx — resolve
// AuthContext, redirect to /login if unauthenticated, hasPermission() check,
// calm access-denied message otherwise. "queryAuditLogs" is a Phase-1
// grantable capability (lib/platform-staff/capabilities.ts), so unlike
// /platform/staff this page IS reachable by a platform_admin who has been
// granted it, in addition to platform_owner always.
//
// Filters are read from the URL's query string and the page is rendered
// server-side per navigation — a plain GET <form> re-navigates with new
// query params, matching this project's existing preference for the
// simplest mechanism that satisfies the requirement (no client component
// needed just to filter/paginate a table).
export default async function AuditLogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const allowed = await hasPermission(context, AUDIT_LOGS_CAPABILITY);

  if (!allowed) {
    return (
      <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        <h1>Access denied</h1>
        <p>You don&apos;t have permission to view this page.</p>
      </main>
    );
  }

  const params = await searchParams;
  const get = (key: string): string => {
    const value = params[key];
    return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
  };

  const actorRole = get("actorRole");
  const action = get("action");
  const academyId = get("academyId");
  const branchId = get("branchId");
  const result = get("result");
  const createdFrom = get("createdFrom");
  const createdTo = get("createdTo");
  const pageParam = Number.parseInt(get("page"), 10);
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;

  const response = await queryAuditLogs(
    {
      actorRole: actorRole || undefined,
      action: action || undefined,
      academyId: academyId || undefined,
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
      <h1>Audit logs</h1>

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
          Academy ID
          <input type="text" name="academyId" defaultValue={academyId} />
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

      {!response.ok ? (
        <p role="alert" style={{ color: "crimson" }}>
          {response.error.message}
        </p>
      ) : (
        <>
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
