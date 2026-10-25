import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getAuditLogsForOwnAcademy } from "@/lib/academies/audit-logs-actions";
import { listBranches } from "@/lib/academies/branches";
import type { AuditResult } from "@/lib/audit-query";
import { ACADEMY_ROLES } from "@/lib/auth/roles";
import { ACADEMY_ROLE_LABELS } from "@/lib/auth/role-labels";
import { PAGE_WRAP, PageHeader, PageMessage, Section, EmptyState } from "@/app/academy/_shell/ui";
import { DataTable, NoteBlock, rtTh } from "@/app/academy/_shell/page-blocks";
import { ChipParamFilter, ClearFilters, DateParamField, FilterBar, FilterDropdown } from "@/app/academy/_shell/filter-controls";
import { Icon } from "@/app/academy/_shell/icons";
import { PaginationNav } from "@/components/pagination-nav";
import { AuditLogExportButton } from "./audit-log-export-button";
import { AuditRows } from "./audit-rows";

/**
 * Audit log (design A19): actions taken in this academy, filtered by
 * result, role, branch and date, exportable as CSV. Only roles with audit
 * access reach it (getAuditLogsForOwnAcademy checks), and every row is
 * scoped to the caller's own academy.
 */
export default async function AcademyAuditLogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await getAuthContext();
  if (!context) redirect("/login");

  const params = await searchParams;
  const get = (key: string): string => {
    const value = params[key];
    return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
  };
  const actorRole = get("actorRole");
  const branchId = get("branchId");
  const result = get("result");
  const createdFrom = get("createdFrom");
  const createdTo = get("createdTo");
  const pageParam = Number.parseInt(get("page"), 10);
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;

  const response = await getAuditLogsForOwnAcademy(
    {
      actorRole: actorRole || undefined,
      branchId: branchId || undefined,
      result: (result || undefined) as AuditResult | undefined,
      createdFrom: createdFrom ? new Date(`${createdFrom}T00:00:00`) : undefined,
      createdTo: createdTo ? new Date(`${createdTo}T23:59:59.999`) : undefined,
    },
    { page },
  );
  if (!response.ok) {
    return <PageMessage title="Access denied" message={response.error.message} />;
  }

  const branchesResult = await listBranches(context);
  const branches = branchesResult.ok ? branchesResult.branches : [];
  const filtered = Boolean(actorRole || branchId || result || createdFrom || createdTo);

  return (
    <div className={PAGE_WRAP}>
      <PageHeader
        title="Audit log"
        description="Actions taken in this academy. Only the owner and administrator can see this page."
        actions={
          <AuditLogExportButton
            filters={{
              actorRole: actorRole || undefined,
              branchId: branchId || undefined,
              result: result || undefined,
              createdFrom: createdFrom || undefined,
              createdTo: createdTo || undefined,
            }}
          />
        }
      />

      <div className="mb-4">
        <ChipParamFilter
          param="result"
          label="Filter by result"
          options={[
            { value: "", label: "All" },
            { value: "success", label: "Success" },
            { value: "failure", label: "Failed" },
          ]}
        />
      </div>
      <FilterBar>
        <FilterDropdown
          param="actorRole"
          label="Role"
          icon="badge"
          options={[{ value: "", label: "All roles" }, ...ACADEMY_ROLES.map((role) => ({ value: role, label: ACADEMY_ROLE_LABELS[role] }))]}
        />
        {branches.length > 1 && (
          <FilterDropdown
            param="branchId"
            label="Branch"
            icon="apartment"
            options={[{ value: "", label: "All branches" }, ...branches.map((b) => ({ value: b.id, label: b.name }))]}
          />
        )}
        <DateParamField param="createdFrom" label="From" />
        <DateParamField param="createdTo" label="To" />
        <ClearFilters params={["actorRole", "branchId", "result", "createdFrom", "createdTo"]} />
      </FilterBar>

      {response.data.rows.length === 0 ? (
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
            <PaginationNav
              page={response.data.page}
              pageSize={response.data.pageSize}
              totalCount={response.data.totalCount}
              searchParams={params}
            />
          }
        >
          <thead>
            <tr>
              <th className={rtTh}>When</th>
              <th className={rtTh}>Who</th>
              <th className={rtTh}>What happened</th>
              <th className={rtTh}>Record</th>
              <th className={rtTh}>Result</th>
              <th className={rtTh}>
                <span className="sr-only">Details</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <AuditRows rows={response.data.rows} actorLabels={response.actorEmailsByUserId} roleLabels={ACADEMY_ROLE_LABELS} />
          </tbody>
        </DataTable>
      )}

      <NoteBlock>
        Times are shown in Somalia time. Open Details on a row to see the values before and after the change. Exports use
        the filters shown here.
      </NoteBlock>
    </div>
  );
}
