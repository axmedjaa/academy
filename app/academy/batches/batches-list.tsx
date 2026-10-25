"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { deleteBatch, setBatchStatus } from "@/lib/academies/batches-actions";
import type { BatchDeletionEligibilitySummary, BatchRecord } from "@/lib/academies/batches";
import { Badge, Button, EmptyState, PageHeader, Section, trHover } from "@/app/academy/_shell/ui";
import { DataTable, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
import { formatDate } from "@/lib/ui/date";
import { Icon } from "@/app/academy/_shell/icons";
import { ConfirmButton } from "@/app/academy/_shell/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BatchFormDialog, type BatchBranchOption, type BatchCourseOption } from "./batch-form";

/**
 * Batches (design A08): header with New batch, the Batch / Courses / Branch /
 * Starts / Status / Roster table, Archive or Restore per row and Edit in the
 * row menu. New and Edit use the design form dialog in batch-form.tsx.
 */

const ROW_BTN =
  "inline-flex h-10 items-center whitespace-nowrap rounded-lg border border-border-strong bg-surface px-3.5 text-[13px] font-semibold text-ink transition-colors duration-150 hover:bg-app disabled:opacity-50";

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

const STATUS_TONE: Record<BatchRecord["status"], "blue" | "green" | "slate" | "gray"> = {
  planned: "blue",
  active: "green",
  completed: "slate",
  archived: "gray",
};

export function BatchesList({ batches, branches, courses, canManage, canDelete }: Props) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Which row's Archive/Restore or Delete confirmation is open.
  const [archiveRowId, setArchiveRowId] = useState<string | null>(null);
  const [deleteRowId, setDeleteRowId] = useState<string | null>(null);
  const editingBatch = batches.find((batch) => batch.id === editingId) ?? null;

  const courseNameById = new Map(courses.map((course) => [course.id, course.name]));
  const branchNameById = new Map(branches.map((branch) => [branch.id, branch.name]));

  function toggleBatchStatus(batch: BatchRecord) {
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
        <DataTable stackBelow={900}>
          <thead>
            <tr>
              <th className={rtTh}>Batch</th>
              <th className={rtTh}>Courses</th>
              <th className={rtTh}>Branch</th>
              <th className={rtTh}>Starts</th>
              <th className={rtTh}>Status</th>
              <th className={rtTh}>Roster</th>
              {canManage && <th className={rtTh}><span className="sr-only">Actions</span></th>}
            </tr>
          </thead>
          <tbody>
            {batches.map((batch) => (
              <tr key={batch.id} className={trHover}>
                <td className={rtTd} data-label="Batch">
                  <span className="flex flex-col">
                    <span className="font-semibold tabular-nums">{batch.code}</span>
                    <span className="text-xs text-muted">{batch.name}</span>
                  </span>
                </td>
                <td className={rtTd} data-label="Courses">
                  <span className="flex flex-wrap gap-1.5">
                    {batch.courseIds.map((id) => (
                      <span
                        key={id}
                        className="inline-flex items-center rounded-full bg-brand-tint px-2.5 py-1 text-xs font-semibold leading-snug text-brand"
                      >
                        {courseNameById.get(id) ?? "Unavailable course"}
                      </span>
                    ))}
                  </span>
                </td>
                <td className={rtTd} data-label="Branch">
                  {branchNameById.get(batch.branchId) ?? <span className="text-muted">—</span>}
                </td>
                <td className={`${rtTd} tabular-nums`} data-label="Starts">
                  {formatDate(batch.startDate)}
                </td>
                <td className={rtTd} data-label="Status">
                  <Badge label={batch.status} tone={STATUS_TONE[batch.status]} />
                </td>
                <td className={rtTd} data-label="Roster">
                  <Link href={`/academy/batches/${batch.id}`} className="min-h-11 inline-flex items-center font-semibold !text-brand hover:underline">
                    Open
                  </Link>
                </td>
                {canManage && (
                  <td className={rtTd} data-actions="">
                    <span className="inline-flex items-center gap-2">
                      <button type="button" onClick={() => setArchiveRowId(batch.id)} className={ROW_BTN}>
                        {batch.status === "archived" ? "Restore" : "Archive"}
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
                      title={batch.status === "archived" ? `Restore "${batch.name}"?` : `Archive "${batch.name}"?`}
                      description={
                        batch.status === "archived" ? (
                          <>This batch will be marked active again and available for enrollment.</>
                        ) : (
                          <>
                            Archived batches are hidden from new enrollment, but the roster and every student&apos;s
                            history is kept and can be restored at any time.
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
            ))}
          </tbody>
        </DataTable>
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
