import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getAuditLogsForOwnAcademy } from "@/lib/academies/audit-logs-actions";
import type { AuditResult } from "@/lib/audit-query";
import { AuditLogExportButton } from "./audit-log-export-button";
import { Badge, Button, ErrorMessage, PAGE_WRAP, PageHeader, TableWrap, Toolbar, inputClass, td, th, trHover } from "@/app/academy/_shell/ui";

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
    <div className={PAGE_WRAP}>
      <PageHeader title="Academy audit log" description="Every recorded action taken within your academy." />

      {!response.ok ? (
        <ErrorMessage message={response.error.message} />
      ) : (
        <>
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

          <div className="mb-4">
            <AuditLogExportButton
              filters={{
                actorRole: actorRole || undefined,
                action: action || undefined,
                branchId: branchId || undefined,
                result: result || undefined,
                createdFrom: createdFrom || undefined,
                createdTo: createdTo || undefined,
              }}
            />
          </div>

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
