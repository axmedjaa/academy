import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasPermission } from "@/lib/auth/permissions";
import { queryAuditLogs } from "@/lib/audit-query-actions";
import type { AuditLogFilters, AuditResult } from "@/lib/audit-query";
import { ACADEMY_ROLE_LABELS } from "@/lib/auth/role-labels";
import { EmptyState, ErrorMessage, PAGE_WRAP, PageHeader, PageMessage, Section } from "@/app/academy/_shell/ui";
import { DataTable, NoteBlock, rtTh } from "@/app/academy/_shell/page-blocks";
import { ClearFilters, DateParamField, FilterBar, FilterDropdown, SearchField } from "@/app/academy/_shell/filter-controls";
import { Icon } from "@/app/academy/_shell/icons";
import { PaginationNav } from "@/components/pagination-nav";
import { AuditRows } from "@/app/academy/audit-logs/audit-rows";
import { PlatformAuditExportButton } from "./export-button";

const AUDIT_LOGS_CAPABILITY = "queryAuditLogs";

const ROLE_LABELS: Record<string, string> = {
  ...ACADEMY_ROLE_LABELS,
  platform_owner: "Platform Owner",
  platform_admin: "Platform Admin",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Audit log (design P10): every recorded action across the platform, with
 * search (actor email, action, entity), a Result filter, a date range,
 * rows that expand to their before and after values, and Export CSV of
 * the filtered set. The `action`, `actorRole`, `academyId` and `branchId`
 * URL filters are still honoured for deep links.
 */
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

  const search = get("q").trim().slice(0, 200);
  const actorRole = get("actorRole");
  const action = get("action");
  const academyId = get("academyId");
  const branchId = get("branchId");
  const result = get("result");
  const createdFrom = get("createdFrom");
  const createdTo = get("createdTo");
  const pageParam = Number.parseInt(get("page"), 10);
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;

  const filters: AuditLogFilters = {
    search: search || undefined,
    actorRole: actorRole || undefined,
    action: action || undefined,
    academyId: UUID.test(academyId) ? academyId : undefined,
    branchId: UUID.test(branchId) ? branchId : undefined,
    result: result === "success" || result === "failure" ? (result as AuditResult) : undefined,
    createdFrom: createdFrom ? new Date(`${createdFrom}T00:00:00`) : undefined,
    createdTo: createdTo ? new Date(`${createdTo}T23:59:59.999`) : undefined,
  };
  const response = await queryAuditLogs(filters, { page });
  const filtered = Boolean(search || actorRole || action || academyId || branchId || result || createdFrom || createdTo);

  return (
    <div className={PAGE_WRAP}>
      <PageHeader title="Audit log" description="Every platform action, with before and after values." />

      <FilterBar>
        <SearchField placeholder="Search actor, action or entity" />
        <FilterDropdown
          param="result"
          label="Result"
          icon="fact_check"
          options={[
            { value: "", label: "All results" },
            { value: "success", label: "Success" },
            { value: "failure", label: "Failed" },
          ]}
        />
        <DateParamField param="createdFrom" label="From" />
        <DateParamField param="createdTo" label="To" />
        <ClearFilters params={["q", "result", "createdFrom", "createdTo", "action", "actorRole", "academyId", "branchId"]} />
        <span className="ml-auto">
          <PlatformAuditExportButton filters={filters} />
        </span>
      </FilterBar>

      {!response.ok ? (
        <ErrorMessage message={response.error.message} />
      ) : response.data.rows.length === 0 ? (
        <Section className="mb-8">
          <EmptyState
            message={filtered ? "No actions match these filters." : "No actions recorded yet."}
            icon={<Icon name="history" />}
          />
        </Section>
      ) : (
        <DataTable
          stackBelow={900}
          footer={
            <>
              <p className="mt-3 text-sm text-muted">
                Showing {response.data.rows.length} of {response.data.totalCount}
              </p>
              <PaginationNav
                page={response.data.page}
                pageSize={response.data.pageSize}
                totalCount={response.data.totalCount}
                searchParams={params}
              />
            </>
          }
        >
          <thead>
            <tr>
              <th className={rtTh}>When</th>
              <th className={rtTh}>Actor</th>
              <th className={rtTh}>Action</th>
              <th className={rtTh}>Entity</th>
              <th className={rtTh}>Result</th>
              <th className={rtTh}>
                <span className="sr-only">Details</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <AuditRows rows={response.data.rows} actorLabels={response.actorEmailsByUserId} roleLabels={ROLE_LABELS} />
          </tbody>
        </DataTable>
      )}

      <NoteBlock>
        Times are shown in Somalia time. Open Details on a row to see the values before and after the change. Export CSV
        includes every row that matches the current filters, not only this page.
      </NoteBlock>
    </div>
  );
}
