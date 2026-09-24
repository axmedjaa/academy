"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import {
  createExam,
  deleteExam,
  enterMarks,
  getExamResultsRoster,
  setExamStatus,
  type ExamFormState,
} from "@/lib/academies/exams-actions";
import type { ExamRecord, ExamResultRosterRow } from "@/lib/academies/exams";
import type { BatchRecord } from "@/lib/academies/batches";
import {
  Badge,
  Button,
  ErrorMessage,
  Field,
  Section,
  TableWrap,
  inputClass,
  td,
  th,
  trHover,
} from "@/app/academy/_shell/ui";
import { ConfirmButton } from "@/app/academy/_shell/confirm-dialog";

const initialState: ExamFormState = { ok: false };

interface Props {
  exams: (ExamRecord & { hasResults: boolean })[];
  batches: BatchRecord[];
  canManage: boolean;
  canEnterMarks: boolean;
}

function statusTone(status: string): "green" | "amber" | "gray" | "blue" {
  if (status === "completed" || status === "published") return "green";
  if (status === "marks_entered" || status === "under_review") return "amber";
  if (status === "draft" || status === "scheduled") return "blue";
  return "gray";
}

export function ExamsList({ exams, batches, canManage, canEnterMarks }: Props) {
  const [createState, createFormAction, createPending] = useActionState(createExam, initialState);
  const [openExamId, setOpenExamId] = useState<string | null>(null);
  const showActions = canManage || canEnterMarks;

  function toggleExamStatus(exam: ExamRecord) {
    return setExamStatus(exam.id, exam.status === "archived" ? "scheduled" : "archived");
  }

  function removeExam(examId: string) {
    return deleteExam(examId);
  }

  return (
    <div className="flex flex-col gap-8">
      <section>
        <h2 className="mb-3 text-lg font-semibold text-ink">Exams</h2>
        <TableWrap>
          <thead>
            <tr>
              <th className={th}>Name</th>
              <th className={th}>Max marks</th>
              <th className={th}>Date</th>
              <th className={th}>Status</th>
              {showActions && <th className={th}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {exams.length === 0 && (
              <tr>
                <td colSpan={showActions ? 5 : 4} className={`${td} text-center text-muted`}>
                  No exams yet.
                </td>
              </tr>
            )}
            {exams.map((exam) => (
              <tr key={exam.id} className={trHover}>
                <td className={`${td} font-medium`}>{exam.name}</td>
                <td className={td}>{exam.maxMarks}</td>
                <td className={td}>{exam.examDate ?? "—"}</td>
                <td className={td}>
                  <Badge label={exam.status} tone={statusTone(exam.status)} />
                </td>
                {showActions && (
                  <td className={td}>
                    <div className="flex flex-wrap gap-2">
                      {canEnterMarks && (
                        <Button
                          type="button"
                          variant="secondary"
                          className="px-2.5 py-1 text-xs"
                          onClick={() => setOpenExamId(openExamId === exam.id ? null : exam.id)}
                        >
                          {openExamId === exam.id ? "Close" : "Enter marks"}
                        </Button>
                      )}
                      {canManage && (
                        <ConfirmButton
                          label={exam.status === "archived" ? "Restore" : "Archive"}
                          variant={exam.status === "archived" ? "secondary" : "danger"}
                          className="px-2.5 py-1 text-xs"
                          title={exam.status === "archived" ? `Restore "${exam.name}"?` : `Archive "${exam.name}"?`}
                          description={
                            exam.status === "archived" ? (
                              <>This exam will be marked scheduled again.</>
                            ) : (
                              <>
                                Archived exams are hidden from active use, but every entered mark and
                                result is kept and can be restored at any time.
                              </>
                            )
                          }
                          onConfirm={() => toggleExamStatus(exam)}
                        />
                      )}
                      {canManage && (
                        <span
                          title={
                            exam.hasResults
                              ? "This exam has student results attached to it, so it can't be permanently deleted. Use Archive instead."
                              : undefined
                          }
                        >
                          <ConfirmButton
                            label="Delete"
                            variant="dangerSolid"
                            className="px-2.5 py-1 text-xs"
                            disabled={exam.hasResults}
                            title={`Permanently delete "${exam.name}"?`}
                            description={
                              <>
                                This cannot be undone. The exam will be permanently removed from the
                                database — this is only possible because it has no student results
                                attached yet.
                              </>
                            }
                            onConfirm={() => removeExam(exam.id)}
                          />
                        </span>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </TableWrap>
        {openExamId && <MarksEntryPanel examId={openExamId} />}
      </section>

      {canManage && (
        <Section>
          <h2 className="text-base font-semibold text-ink">Create exam</h2>
          <form action={createFormAction} className="mt-4 flex max-w-md flex-col gap-3">
            <Field label="Batch">
              <select name="batchId" required className={inputClass}>
                {batches.map((batch) => (
                  <option key={batch.id} value={batch.id}>
                    {batch.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Name">
              <input type="text" name="name" required className={inputClass} />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Max marks">
                <input type="number" name="maxMarks" min="1" step="any" required className={inputClass} />
              </Field>
              <Field label="Exam date (optional)">
                <input type="date" name="examDate" className={inputClass} />
              </Field>
            </div>
            {createState.error && <ErrorMessage message={createState.error.message} />}
            {createState.ok && <p className="text-sm font-medium text-success">Exam created.</p>}
            <Button type="submit" disabled={createPending} className="self-start">
              {createPending ? "Creating..." : "Create exam"}
            </Button>
          </form>
        </Section>
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
    <Section className="mt-3">
      <h3 className="text-sm font-semibold text-ink">Marks</h3>
      {!roster && !error && <p className="mt-2 text-sm text-muted">Loading roster...</p>}
      {error && (
        <div className="mt-2">
          <ErrorMessage message={error} />
        </div>
      )}
      {roster && roster.length === 0 && <p className="mt-2 text-sm text-muted">No students enrolled in this batch.</p>}
      {roster && roster.length > 0 && (
        <div className="mt-3">
          <TableWrap>
            <thead>
              <tr>
                <th className={th}>Student</th>
                <th className={th}>Status</th>
                <th className={th}>Marks</th>
              </tr>
            </thead>
            <tbody>
              {roster.map((row) => (
                <tr key={row.id} className={trHover}>
                  <td className={td}>
                    {row.studentFullName} <span className="text-muted">({row.studentNumber})</span>
                  </td>
                  <td className={td}>
                    <Badge label={row.status} tone={statusTone(row.status)} />
                  </td>
                  <td className={td}>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={marks[row.studentId] ?? ""}
                      disabled={row.status !== "draft" && row.status !== "marks_entered"}
                      onChange={(event) => setMarks((prev) => ({ ...prev, [row.studentId]: event.target.value }))}
                      className={`${inputClass} w-28 py-1.5`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </div>
      )}
      {saved && <p className="mt-2 text-sm font-medium text-success">Marks saved.</p>}
      {roster && roster.length > 0 && (
        <Button type="button" onClick={handleSubmit} disabled={isPending} className="mt-3">
          {isPending ? "Saving..." : "Save marks"}
        </Button>
      )}
    </Section>
  );
}
