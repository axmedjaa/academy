"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { deleteBatch, setBatchStatus } from "@/lib/academies/batches-actions";
import type { BatchDeletionEligibilitySummary, BatchRecord } from "@/lib/academies/batches";
import { Badge, Button, EmptyState, PageHeader, Section, trHover } from "@/app/academy/_shell/ui";
import { DataTable, StatRow, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
import { Icon } from "@/app/academy/_shell/icons";
import { ConfirmButton } from "@/app/academy/_shell/confirm-dialog";
import { controlClass } from "@/app/academy/_shell/design-form";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BatchFormDialog, type BatchBranchOption, type BatchCourseOption } from "./batch-form";
import {
  BATCH_STATUS_LABEL,
  BATCH_STATUS_TONE,
  batchStartDate,
  formatCourseDate,
  type BatchStatus,
} from "./batch-status";

/**
 * Batches (design A08 list): header with New batch, the batch counts,
 * search and filters, then the Batch /
 * Courses / Branch / Starts / Status / Roster table with Archive or Restore
 * per row and Edit / Delete in the row menu. New and Edit use the design form dialog in batch-form.tsx.
 */

const ROW_BTN =
  "inline-flex h-10 items-center whitespace-nowrap rounded-lg border border-border-strong bg-surface px-3.5 text-[13px] font-semibold text-ink transition-colors duration-150 hover:bg-app disabled:opacity-50";

const STATUS_ORDER: BatchStatus[] = ["planned", "active", "completed", "archived"];

interface Props {
  batches: (BatchRecord & { deletionEligibility: BatchDeletionEligibilitySummary })[];
  branches: BatchBranchOption[];
  courses: BatchCourseOption[];
  canManage: boolean;
  /** Narrower than `canManage` — Trainer can archive their own assigned
   * batches but must never see a Delete action at all (permission-absent,
   * not disabled — see lib/academies/batches.ts's canDeleteBatch). */
  canDelete: boolean;
}

export function BatchesList({ batches, branches, courses, canManage, canDelete }: Props) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Which row's Archive/Restore or Delete confirmation is open.
  const [archiveRowId, setArchiveRowId] = useState<string | null>(null);
  const [deleteRowId, setDeleteRowId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | BatchStatus>("");
  const [branchFilter, setBranchFilter] = useState("");
  const editingBatch = batches.find((batch) => batch.id === editingId) ?? null;

  const courseNameById = useMemo(() => new Map(courses.map((course) => [course.id, course.name])), [courses]);
  const branchNameById = useMemo(() => new Map(branches.map((branch) => [branch.id, branch.name])), [branches]);
  const counts = useMemo(() => {
    const byStatus: Record<BatchStatus, number> = { planned: 0, active: 0, completed: 0, archived: 0 };
    for (const batch of batches) byStatus[batch.status] += 1;
    return byStatus;
  }, [batches]);
  // Branch filter only lists branches that actually have a batch here.
  const branchOptions = useMemo(
    () =>
      [...new Set(batches.map((batch) => batch.branchId))]
        .map((id) => ({ id, name: branchNameById.get(id) ?? "Branch unavailable" }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [batches, branchNameById],
  );

  const q = query.trim().toLowerCase();
  const rows = batches.filter(
    (batch) =>
      (!statusFilter || batch.status === statusFilter) &&
      (!branchFilter || batch.branchId === branchFilter) &&
      (!q ||
        `${batch.code} ${batch.name} ${batch.courseIds.map((id) => courseNameById.get(id) ?? "").join(" ")}`.toLowerCase().includes(q)),
  );
  const filtered = Boolean(q || statusFilter || branchFilter);
  const clearFilters = () => {
    setQuery("");
    setStatusFilter("");
    setBranchFilter("");
  };

  function toggleBatchStatus(batch: BatchRecord) {
    // "active" asks the server to Restore, which brings back the status the
    // batch had before it was archived (lib/academies/batches.ts restoreBatch).
    return setBatchStatus(batch.id, batch.status === "archived" ? "active" : "archived");
  }

  return (
    <section className="flex flex-col">
      <PageHeader
        title="Batches"
        description="Cohorts at one branch. A batch can run one course or several."
        actions={
          canManage ? (
            <Button type="button" onClick={() => setCreateOpen(true)}>
              New batch
            </Button>
          ) : undefined
        }
      />

      {batches.length === 0 ? (
        <Section>
          <EmptyState message={canManage ? "No batches yet. Create one to start enrolling students." : "No batches to show yet."} icon={<Icon name="layers" />} />
        </Section>
      ) : (
        <>
          <StatRow
            items={[
              { label: "Batches", value: batches.length, hint: `${counts.archived} archived`, icon: "layers" },
              {
                label: "Accepting students",
                value: counts.planned + counts.active,
                hint: `${counts.planned} planned, ${counts.active} active`,
                icon: "user_plus",
              },
              { label: "Completed", value: counts.completed, hint: "No new enrollments", icon: "check_circle" },
            ]}
          />

          <div className="mb-4 flex flex-wrap items-end gap-3" role="search" aria-label="Filter batches">
            <label className="flex min-w-0 flex-[1_1_240px] flex-col gap-1">
              <span className="sr-only">Search batches</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search batch code, name or course"
                className={controlClass(false)}
              />
            </label>
            <label className="flex flex-[0_1_200px] flex-col gap-1">
              <span className="sr-only">Status</span>
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as "" | BatchStatus)} className={controlClass(false)}>
                <option value="">All statuses</option>
                {STATUS_ORDER.map((status) => (
                  <option key={status} value={status}>
                    {BATCH_STATUS_LABEL[status]} ({counts[status]})
                  </option>
                ))}
              </select>
            </label>
            {branchOptions.length > 1 && (
              <label className="flex flex-[0_1_200px] flex-col gap-1">
                <span className="sr-only">Branch</span>
                <select value={branchFilter} onChange={(event) => setBranchFilter(event.target.value)} className={controlClass(false)}>
                  <option value="">All branches</option>
                  {branchOptions.map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {filtered && (
              <button type="button" onClick={clearFilters} className="inline-flex min-h-11 items-center px-2 text-sm font-semibold text-brand hover:underline">
                Clear filters
              </button>
            )}
          </div>

          {rows.length === 0 ? (
            <div className="mb-8 flex flex-col items-center gap-2 rounded-card border border-border bg-surface px-6 py-10 text-center shadow-card">
              <p className="font-semibold text-ink">No batches match</p>
              <p className="text-sm text-muted">Try other words or clear the filters.</p>
              <button type="button" onClick={clearFilters} className={`${ROW_BTN} mt-1 h-11`}>
                Clear filters
              </button>
            </div>
          ) : (
            <DataTable stackBelow={900}>
              <thead>
                <tr>
                  <th className={rtTh}>Batch</th>
                  <th className={rtTh}>Courses</th>
                  <th className={rtTh}>Branch</th>
                  <th className={rtTh}>Starts</th>
                  <th className={rtTh}>Status</th>
                  <th className={rtTh}>Roster</th>
                  {canManage && (
                    <th className={rtTh}>
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((batch) => {
                  const start = batchStartDate(batch);
                  return (
                    <tr key={batch.id} className={trHover}>
                      <td className={rtTd} data-label="Batch">
                        <span className="flex flex-col">
                          <span className="font-semibold tabular-nums">{batch.code}</span>
                          <span className="text-xs text-muted">{batch.name}</span>
                        </span>
                      </td>
                      <td className={rtTd} data-label="Courses">
                        {(() => {
                          // Design A08 `cTags`: the first two courses, then "+N more"
                          // (every name stays in the tooltip and for screen readers).
                          const names = batch.courseIds.map((id) => courseNameById.get(id) ?? "Unavailable course");
                          const shown = names.slice(0, 2);
                          const rest = names.slice(2);
                          const chip = "inline-flex max-w-full items-center rounded-full bg-brand-tint px-2.5 py-1 text-xs font-semibold leading-snug text-brand";
                          return (
                            <span className="flex flex-wrap gap-1.5" title={rest.length ? names.join(", ") : undefined}>
                              {shown.map((name, index) => (
                                <span key={`${name}-${index}`} className={`${chip} [overflow-wrap:anywhere]`}>
                                  {name}
                                </span>
                              ))}
                              {rest.length > 0 && (
                                <span className={`${chip} whitespace-nowrap`}>
                                  +{rest.length} more<span className="sr-only">: {rest.join(", ")}</span>
                                </span>
                              )}
                            </span>
                          );
                        })()}
                      </td>
                      <td className={rtTd} data-label="Branch">
                        {branchNameById.get(batch.branchId) ?? <span className="text-muted">—</span>}
                      </td>
                      <td className={`${rtTd} whitespace-nowrap tabular-nums`} data-label="Starts">
                        {start ? formatCourseDate(start) : <span className="text-muted">Not set</span>}
                      </td>
                      <td className={rtTd} data-label="Status">
                        <Badge label={BATCH_STATUS_LABEL[batch.status]} tone={BATCH_STATUS_TONE[batch.status]} />
                      </td>
                      <td className={rtTd} data-label="Roster">
                        <Link href={`/academy/batches/${batch.id}`} className="inline-flex min-h-11 items-center font-semibold !text-brand hover:underline">
                          Open
                        </Link>
                      </td>
                      {canManage && (
                        <td className={rtTd} data-actions="">
                          <span className="inline-flex items-center gap-2">
                            <button type="button" onClick={() => setArchiveRowId(batch.id)} className={ROW_BTN}>
                              <Icon name={batch.status === "archived" ? "autorenew" : "archive"} width={16} height={16} />
                              <span className="ml-1.5">{batch.status === "archived" ? "Restore" : "Archive"}</span>
                            </button>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button
                                  type="button"
                                  aria-label={`More actions for ${batch.name}`}
                                  className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-muted transition-colors duration-150 hover:bg-app hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                                >
                                  <Icon name="more" />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => setEditingId(batch.id)}>Edit</DropdownMenuItem>
                                {canDelete && <DropdownMenuSeparator />}
                                {!canDelete ? null : batch.deletionEligibility.eligible ? (
                                  <DropdownMenuItem variant="destructive" onClick={() => setDeleteRowId(batch.id)}>
                                    Delete
                                  </DropdownMenuItem>
                                ) : (
                                  <DropdownMenuItem
                                    disabled
                                    title={`This batch cannot be permanently deleted because ${batch.deletionEligibility.reasons.join("; ")}. Use Archive instead.`}
                                  >
                                    Delete
                                  </DropdownMenuItem>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </span>

                          <ConfirmButton
                            label={batch.status === "archived" ? "Restore" : "Archive"}
                            variant={batch.status === "archived" ? "success" : "danger"}
                            icon={batch.status === "archived" ? "autorenew" : "archive"}
                            open={archiveRowId === batch.id}
                            onOpenChange={(nextOpen) => setArchiveRowId(nextOpen ? batch.id : null)}
                            title={batch.status === "archived" ? `Restore ${batch.code}?` : `Archive ${batch.code}?`}
                            description={
                              batch.status === "archived" ? (
                                <>
                                  <b>{batch.name}</b> goes back to the status it had before it was archived (Planned, Active or
                                  Completed). Planned and Active batches accept new students again.
                                </>
                              ) : (
                                <>
                                  <b>{batch.name}</b> stops accepting new students and is marked Archived. Its roster, fee plans
                                  and every student&apos;s history are kept. Use Restore to bring it back with its current
                                  status ({BATCH_STATUS_LABEL[batch.status]}).
                                </>
                              )
                            }
                            successMessage={batch.status === "archived" ? "Batch restored." : "Batch archived."}
                            onConfirm={() => toggleBatchStatus(batch)}
                          />
                          {canDelete && batch.deletionEligibility.eligible && (
                            <ConfirmButton
                              label="Delete"
                              variant="dangerSolid"
                              open={deleteRowId === batch.id}
                              onOpenChange={(nextOpen) => setDeleteRowId(nextOpen ? batch.id : null)}
                              title={`Delete "${batch.name}" permanently?`}
                              description={<>This cannot be undone.</>}
                              confirmInput={{ label: `Type "${batch.name}" to confirm`, requiredValue: batch.name }}
                              successMessage="Batch deleted."
                              onConfirm={() => deleteBatch(batch.id, batch.name)}
                            />
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
          )}
        </>
      )}

      {canManage && (
        <>
          <BatchFormDialog
            open={createOpen}
            onOpenChange={setCreateOpen}
            batch={null}
            branches={branches}
            courses={courses}
            onSaved={() => router.refresh()}
          />
          <BatchFormDialog
            open={editingBatch !== null}
            onOpenChange={(next) => !next && setEditingId(null)}
            batch={editingBatch}
            branches={branches}
            courses={courses}
            onSaved={() => router.refresh()}
          />
        </>
      )}
    </section>
  );
}
