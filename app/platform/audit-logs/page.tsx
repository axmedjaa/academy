import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasPermission } from "@/lib/auth/permissions";
import { queryAuditLogs } from "@/lib/audit-query-actions";
import type { AuditResult } from "@/lib/audit-query";
import { Badge, Button, ErrorMessage, PAGE_WRAP, PageHeader, PageMessage, TableWrap, Toolbar, inputClass, td, th, trHover } from "@/app/academy/_shell/ui";

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
    return <PageMessage title="Access denied" message="You don't have permission to view this page." />;
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
    <div className={PAGE_WRAP}>
      <PageHeader title="Audit logs" description="Every recorded action across the whole platform." />

      <form method="get">
        <Toolbar>
          <label className="min-w-[140px]">
            <span className="mb-1 block text-xs font-medium text-muted">Action</span>
            <input type="text" name="action" defaultValue={action} className={inputClass} />
          </label>
          <label className="min-w-[140px]">
            <span className="mb-1 block text-xs font-medium text-muted">Actor role</span>
            <input type="text" name="actorRole" defaultValue={actorRole} className={inputClass} />
          </label>
          <label className="min-w-[140px]">
            <span className="mb-1 block text-xs font-medium text-muted">Academy ID</span>
            <input type="text" name="academyId" defaultValue={academyId} className={inputClass} />
          </label>
          <label className="min-w-[140px]">
            <span className="mb-1 block text-xs font-medium text-muted">Branch ID</span>
            <input type="text" name="branchId" defaultValue={branchId} className={inputClass} />
          </label>
          <label className="min-w-[120px]">
            <span className="mb-1 block text-xs font-medium text-muted">Result</span>
            <select name="result" defaultValue={result} className={inputClass}>
              <option value="">Any</option>
              <option value="success">Success</option>
              <option value="failure">Failure</option>
            </select>
          </label>
          <label className="min-w-[140px]">
            <span className="mb-1 block text-xs font-medium text-muted">From</span>
            <input type="date" name="createdFrom" defaultValue={createdFrom} className={inputClass} />
          </label>
          <label className="min-w-[140px]">
            <span className="mb-1 block text-xs font-medium text-muted">To</span>
            <input type="date" name="createdTo" defaultValue={createdTo} className={inputClass} />
          </label>
          <Button type="submit" variant="secondary">
            Filter
          </Button>
        </Toolbar>
      </form>

      {!response.ok ? (
        <ErrorMessage message={response.error.message} />
      ) : (
        <>
          <TableWrap>
            <thead>
              <tr>
                <th className={th}>When</th>
                <th className={th}>Action</th>
                <th className={th}>Actor role</th>
                <th className={th}>Entity</th>
                <th className={th}>Result</th>
              </tr>
            </thead>
            <tbody>
              {response.data.rows.map((row) => (
                <tr key={row.id} className={trHover}>
                  <td className={`${td} whitespace-nowrap`}>{row.createdAt.toISOString()}</td>
                  <td className={td}>{row.action}</td>
                  <td className={td}>{row.actorRole ?? "—"}</td>
                  <td className={td}>{row.entityType}</td>
                  <td className={td}>
                    <Badge label={row.result} tone={row.result === "success" ? "green" : "red"} />
                  </td>
                </tr>
              ))}
              {response.data.rows.length === 0 && (
                <tr>
                  <td colSpan={5} className={`${td} text-center text-muted`}>
                    No audit log entries match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </TableWrap>

          <p className="mt-4 text-sm text-muted">
            Page {response.data.page} — {response.data.totalCount} total
            {response.data.totalCount > response.data.pageSize && (
              <>
                {" "}
                (
                {response.data.page > 1 && (
                  <a
                    href={`?${new URLSearchParams({ ...paramsToRecord(params), page: String(response.data.page - 1) }).toString()}`}
                    className="text-brand hover:underline"
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
                    className="text-brand hover:underline"
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
