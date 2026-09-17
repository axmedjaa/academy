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
    <div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>
      <section>
        <h2>Entries</h2>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Batch</th>
              <th style={{ textAlign: "left" }}>Day</th>
              <th style={{ textAlign: "left" }}>Time</th>
              <th style={{ textAlign: "left" }}>Room</th>
              {canManage && <th />}
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr>
                <td colSpan={canManage ? 5 : 4}>No timetable entries yet.</td>
              </tr>
            )}
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>{entry.batchName}</td>
                <td>{entry.dayOfWeek}</td>
                <td>
                  {entry.startTime}–{entry.endTime}
                </td>
                <td>{entry.room ?? "—"}</td>
                {canManage && (
                  <td>
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => handleDelete(entry.id, entry.batchId)}
                    >
                      Delete
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {deleteError && (
          <p role="alert" style={{ color: "crimson" }}>
            {deleteError}
          </p>
        )}
      </section>

      {canManage && (
        <section>
          <h2>Add entry</h2>
          <form
            action={createFormAction}
            style={{ display: "flex", flexDirection: "column", gap: "0.75rem", maxWidth: 360 }}
          >
            <label>
              Branch
              <select name="branchId" required style={{ display: "block", width: "100%" }}>
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Batch
              <select name="batchId" required style={{ display: "block", width: "100%" }}>
                {batches.map((batch) => (
                  <option key={batch.id} value={batch.id}>
                    {batch.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Day
              <select name="dayOfWeek" required style={{ display: "block", width: "100%" }}>
                {DAYS.map((day) => (
                  <option key={day} value={day}>
                    {day}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Start time
              <input type="time" name="startTime" required style={{ display: "block", width: "100%" }} />
            </label>
            <label>
              End time
              <input type="time" name="endTime" required style={{ display: "block", width: "100%" }} />
            </label>
            <label>
              Room (optional)
              <input type="text" name="room" style={{ display: "block", width: "100%" }} />
            </label>
            {createState.error && (
              <p role="alert" style={{ color: "crimson" }}>
                {createState.error.message}
              </p>
            )}
            {createState.ok && <p style={{ color: "green" }}>Entry created.</p>}
            <button type="submit" disabled={createPending}>
              {createPending ? "Creating..." : "Add entry"}
            </button>
          </form>
        </section>
      )}
    </div>
  );
}
