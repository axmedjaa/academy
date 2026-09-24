"use client";

import { useActionState } from "react";
import { createBatch, deleteBatch, setBatchStatus, type BatchFormState } from "@/lib/academies/batches-actions";
import type { BatchDeletionEligibilitySummary, BatchRecord } from "@/lib/academies/batches";
import type { BranchRecord } from "@/lib/academies/branches";
import type { CourseRecord } from "@/lib/academies/courses";
import {
  Badge,
  Button,
  ErrorMessage,
  Field,
  LinkButton,
  Section,
  TableWrap,
  inputClass,
  td,
  th,
  trHover,
} from "@/app/academy/_shell/ui";
import { ConfirmButton, EligibilityGatedDeleteButton } from "@/app/academy/_shell/confirm-dialog";

const initialState: BatchFormState = { ok: false };

interface Props {
  batches: (BatchRecord & { deletionEligibility: BatchDeletionEligibilitySummary })[];
  branches: BranchRecord[];
  courses: CourseRecord[];
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
  const [createState, createFormAction, creating] = useActionState(createBatch, initialState);

  const courseNameById = new Map(courses.map((course) => [course.id, course.name]));

  function toggleBatchStatus(batch: BatchRecord) {
    return setBatchStatus(batch.id, batch.status === "archived" ? "active" : "archived");
  }

  return (
    <section className="flex flex-col gap-6">
      <TableWrap>
        <thead>
          <tr>
            <th className={th}>Name</th>
            <th className={th}>Course</th>
            <th className={th}>Code</th>
            <th className={th}>Start date</th>
            <th className={th}>Status</th>
            <th className={th}>Roster</th>
            {canManage && <th className={th}>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {batches.length === 0 ? (
            <tr>
              <td colSpan={canManage ? 7 : 6} className={`${td} text-center text-muted`}>
                No batches to show.
              </td>
            </tr>
          ) : (
            batches.map((batch) => (
              <tr key={batch.id} className={trHover}>
                <td className={`${td} font-medium`}>{batch.name}</td>
                <td className={td}>{courseNameById.get(batch.courseId) ?? "—"}</td>
                <td className={td}>{batch.code}</td>
                <td className={td}>{batch.startDate}</td>
                <td className={td}>
                  <Badge label={batch.status} tone={STATUS_TONE[batch.status]} />
                </td>
                <td className={td}>
                  <LinkButton href={`/academy/batches/${batch.id}`} variant="secondary" className="px-2.5 py-1 text-xs">
                    View roster
                  </LinkButton>
                </td>
                {canManage && (
                  <td className={td}>
                    <div className="flex flex-wrap gap-2">
                      <ConfirmButton
                        label={batch.status === "archived" ? "Restore" : "Archive"}
                        variant={batch.status === "archived" ? "secondary" : "danger"}
                        className="px-2.5 py-1 text-xs"
                        title={batch.status === "archived" ? `Restore "${batch.name}"?` : `Archive "${batch.name}"?`}
                        description={
                          batch.status === "archived" ? (
                            <>This batch will be marked active again and available for enrollment.</>
                          ) : (
                            <>
                              Archived batches are hidden from new enrollment, but the roster and every
                              student&apos;s history is kept and can be restored at any time.
                            </>
                          )
                        }
                        onConfirm={() => toggleBatchStatus(batch)}
                      />
                      {canDelete && (
                        <EligibilityGatedDeleteButton
                          entityLabel="Batch"
                          entityName={batch.name}
                          eligible={batch.deletionEligibility.eligible}
                          reasons={batch.deletionEligibility.reasons}
                          onConfirm={() => deleteBatch(batch.id, batch.name)}
                        />
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))
          )}
        </tbody>
      </TableWrap>

      {canManage && (
        <Section>
          <h2 className="text-base font-semibold text-ink">Add batch</h2>
          <p className="mt-1 text-sm text-muted">
            A batch is a scheduled offering of a course — pick the course it belongs to, then the branch
            it runs at.
          </p>
          <form action={createFormAction} className="mt-4 flex max-w-lg flex-col gap-3">
            <Field label="Course">
              <select name="courseId" required className={inputClass}>
                {courses.map((course) => (
                  <option key={course.id} value={course.id}>
                    {course.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Branch">
              <select name="branchId" required className={inputClass}>
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Name">
              <input type="text" name="name" required className={inputClass} />
            </Field>
            <Field label="Code">
              <input type="text" name="code" required className={inputClass} />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Start date">
                <input type="date" name="startDate" required className={inputClass} />
              </Field>
              <Field label="End date">
                <input type="date" name="endDate" className={inputClass} />
              </Field>
            </div>
            {createState.error && <ErrorMessage message={createState.error.message} />}
            {createState.ok && <p className="text-sm font-medium text-success">Batch created.</p>}
            <Button type="submit" disabled={creating} className="self-start">
              {creating ? "Creating..." : "Create batch"}
            </Button>
          </form>
        </Section>
      )}
    </section>
  );
}
