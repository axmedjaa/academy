"use client";

import { useActionState, useState, useTransition } from "react";
import {
  createTimetableEntry,
  deleteTimetableEntry,
  type TimetableFormState,
} from "@/lib/academies/timetables-actions";
import type { TimetableEntryWithBatch } from "@/lib/academies/timetables";
import type { BranchRecord } from "@/lib/academies/branches";
import type { BatchRecord } from "@/lib/academies/batches";
import { Button, ErrorMessage, Field, Section, TableWrap, inputClass, td, th, trHover } from "@/app/academy/_shell/ui";

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const initialState: TimetableFormState = { ok: false };

interface Props {
  entries: TimetableEntryWithBatch[];
  branches: BranchRecord[];
  batches: BatchRecord[];
  canManage: boolean;
}

export function TimetableList({ entries, branches, batches, canManage }: Props) {
  const [createState, createFormAction, createPending] = useActionState(
    createTimetableEntry,
    initialState,
  );
  const [isPending, startTransition] = useTransition();
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function handleDelete(entryId: string, batchId: string) {
    setDeleteError(null);
    startTransition(async () => {
      const result = await deleteTimetableEntry(entryId, batchId);
      if (!result.ok) setDeleteError(result.error.message);
    });
  }

  return (
    <div className="flex flex-col gap-8">
      <section>
        <h2 className="mb-3 text-lg font-semibold text-ink">Entries</h2>
        <TableWrap>
          <thead>
            <tr>
              <th className={th}>Batch</th>
              <th className={th}>Day</th>
              <th className={th}>Time</th>
              <th className={th}>Room</th>
              {canManage && <th className={th}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr>
                <td colSpan={canManage ? 5 : 4} className={`${td} text-center text-muted`}>
                  No timetable entries yet.
                </td>
              </tr>
            )}
            {entries.map((entry) => (
              <tr key={entry.id} className={trHover}>
                <td className={`${td} font-medium`}>{entry.batchName}</td>
                <td className={`${td} capitalize`}>{entry.dayOfWeek}</td>
                <td className={td}>
                  {entry.startTime}–{entry.endTime}
                </td>
                <td className={td}>{entry.room ?? "—"}</td>
                {canManage && (
                  <td className={td}>
                    <Button
                      type="button"
                      variant="danger"
                      className="px-2.5 py-1 text-xs"
                      disabled={isPending}
                      onClick={() => handleDelete(entry.id, entry.batchId)}
                    >
                      Delete
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </TableWrap>
        {deleteError && (
          <div className="mt-2">
            <ErrorMessage message={deleteError} />
          </div>
        )}
      </section>

      {canManage && (
        <section>
          <h2 className="mb-3 text-lg font-semibold text-ink">Add entry</h2>
          <Section>
            <form action={createFormAction} className="flex max-w-md flex-col gap-3">
              <Field label="Branch">
                <select name="branchId" required className={inputClass}>
                  {branches.map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Batch">
                <select name="batchId" required className={inputClass}>
                  {batches.map((batch) => (
                    <option key={batch.id} value={batch.id}>
                      {batch.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Day">
                <select name="dayOfWeek" required className={inputClass}>
                  {DAYS.map((day) => (
                    <option key={day} value={day}>
                      {day}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Start time">
                  <input type="time" name="startTime" required className={inputClass} />
                </Field>
                <Field label="End time">
                  <input type="time" name="endTime" required className={inputClass} />
                </Field>
              </div>
              <Field label="Room (optional)">
                <input type="text" name="room" className={inputClass} />
              </Field>
              {createState.error && <ErrorMessage message={createState.error.message} />}
              {createState.ok && <p className="text-sm font-medium text-success">Entry created.</p>}
              <Button type="submit" disabled={createPending} className="self-start">
                {createPending ? "Creating..." : "Add entry"}
              </Button>
            </form>
          </Section>
        </section>
      )}
    </div>
  );
}
