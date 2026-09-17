"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import {
  createExam,
  enterMarks,
  getExamResultsRoster,
  type ExamFormState,
} from "@/lib/academies/exams-actions";
import type { ExamRecord, ExamResultRosterRow } from "@/lib/academies/exams";
import type { BatchRecord } from "@/lib/academies/batches";

const initialState: ExamFormState = { ok: false };

interface Props {
  exams: ExamRecord[];
  batches: BatchRecord[];
  canManage: boolean;
  canEnterMarks: boolean;
}

export function ExamsList({ exams, batches, canManage, canEnterMarks }: Props) {
  const [createState, createFormAction, createPending] = useActionState(createExam, initialState);
  const [openExamId, setOpenExamId] = useState<string | null>(null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>
      <section>
        <h2>Exams</h2>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Name</th>
              <th style={{ textAlign: "left" }}>Max marks</th>
              <th style={{ textAlign: "left" }}>Date</th>
              <th style={{ textAlign: "left" }}>Status</th>
              {canEnterMarks && <th />}
            </tr>
          </thead>
          <tbody>
            {exams.length === 0 && (
              <tr>
                <td colSpan={canEnterMarks ? 5 : 4}>No exams yet.</td>
              </tr>
            )}
            {exams.map((exam) => (
              <tr key={exam.id}>
                <td>{exam.name}</td>
                <td>{exam.maxMarks}</td>
                <td>{exam.examDate ?? "—"}</td>
                <td>{exam.status}</td>
                {canEnterMarks && (
                  <td>
                    <button
                      type="button"
                      onClick={() => setOpenExamId(openExamId === exam.id ? null : exam.id)}
                    >
                      {openExamId === exam.id ? "Close" : "Enter marks"}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {openExamId && <MarksEntryPanel examId={openExamId} />}
      </section>

      {canManage && (
        <section>
          <h2>Create exam</h2>
          <form
            action={createFormAction}
            style={{ display: "flex", flexDirection: "column", gap: "0.75rem", maxWidth: 360 }}
          >
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
              Name
              <input type="text" name="name" required style={{ display: "block", width: "100%" }} />
            </label>
            <label>
              Max marks
              <input
                type="number"
                name="maxMarks"
                min="1"
                step="any"
                required
                style={{ display: "block", width: "100%" }}
              />
            </label>
            <label>
              Exam date (optional)
              <input type="date" name="examDate" style={{ display: "block", width: "100%" }} />
            </label>
            {createState.error && (
              <p role="alert" style={{ color: "crimson" }}>
                {createState.error.message}
              </p>
            )}
            {createState.ok && <p style={{ color: "green" }}>Exam created.</p>}
            <button type="submit" disabled={createPending}>
              {createPending ? "Creating..." : "Create exam"}
            </button>
          </form>
        </section>
      )}
    </div>
  );
}

/** Loads an exam's roster on demand and lets the caller enter/update marks
 * for any subset of students in one `enterMarks` call — see
 * lib/academies/exams.ts's `enterMarks` doc comment for why this is a
 * single all-or-nothing submission rather than per-row saves. */
function MarksEntryPanel({ examId }: { examId: string }) {
  const [isPending, startTransition] = useTransition();
  const [roster, setRoster] = useState<ExamResultRosterRow[] | null>(null);
  const [marks, setMarks] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    startTransition(async () => {
      const result = await getExamResultsRoster(examId);
      if (result.ok) {
        setRoster(result.results);
        const initialMarks: Record<string, string> = {};
        for (const row of result.results) {
          initialMarks[row.studentId] = row.marksObtained !== null ? String(row.marksObtained) : "";
        }
        setMarks(initialMarks);
      } else {
        setError(result.error.message);
      }
    });
  }, [examId]);

  function handleSubmit() {
    setError(null);
    setSaved(false);
    const entries = Object.entries(marks)
      .filter(([, value]) => value.trim() !== "")
      .map(([studentId, value]) => ({ studentId, marksObtained: Number(value) }));
    if (entries.length === 0) {
      setError("Enter at least one mark before saving.");
      return;
    }
    startTransition(async () => {
      const result = await enterMarks(examId, entries);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setSaved(true);
      const refreshed = await getExamResultsRoster(examId);
      if (refreshed.ok) setRoster(refreshed.results);
    });
  }

  return (
    <div style={{ marginTop: "1rem", border: "1px solid #ddd", padding: "1rem" }}>
      <h3>Marks</h3>
      {!roster && !error && <p>Loading roster...</p>}
      {error && (
        <p role="alert" style={{ color: "crimson" }}>
          {error}
        </p>
      )}
      {roster && roster.length === 0 && <p>No students enrolled in this batch.</p>}
      {roster && roster.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Student</th>
              <th style={{ textAlign: "left" }}>Status</th>
              <th style={{ textAlign: "left" }}>Marks</th>
            </tr>
          </thead>
          <tbody>
            {roster.map((row) => (
              <tr key={row.id}>
                <td>
                  {row.studentFullName} ({row.studentNumber})
                </td>
                <td>{row.status}</td>
                <td>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={marks[row.studentId] ?? ""}
                    disabled={row.status !== "draft" && row.status !== "marks_entered"}
                    onChange={(event) =>
                      setMarks((prev) => ({ ...prev, [row.studentId]: event.target.value }))
                    }
                    style={{ width: "6rem" }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {saved && <p style={{ color: "green" }}>Marks saved.</p>}
      {roster && roster.length > 0 && (
        <button type="button" onClick={handleSubmit} disabled={isPending} style={{ marginTop: "0.75rem" }}>
          {isPending ? "Saving..." : "Save marks"}
        </button>
      )}
    </div>
  );
}
