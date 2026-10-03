"use client";

import { useEffect, useState, useTransition } from "react";
import {
  approveResult,
  publishResults,
  rejectResult,
  submitResults,
} from "@/lib/academies/results-actions";
import {
  approveResultCorrection,
  getResultCorrectionsList,
  rejectResultCorrection,
  requestResultCorrection,
} from "@/lib/academies/result-corrections-actions";
import type { ResultRosterRow } from "@/lib/academies/results";
import type { ResultCorrectionRecord } from "@/lib/academies/result-corrections";
import { Badge, Button, EmptyState, ErrorMessage, Field, FormDialog, Section, TableWrap, inputClass, td, th, trHover } from "@/app/academy/_shell/ui";
import { Icon } from "@/app/academy/_shell/icons";
import { StudentAvatar } from "@/app/academy/students/student-avatar";

interface Props {
  results: ResultRosterRow[];
  /** examId -> exam name, resolved in page.tsx via the same `listExams`
   * read app/academy/exams/page.tsx itself uses — display-only, so the
   * "Exam {id}" section headings below show a real name instead of the
   * raw database id. */
  examNames: Record<string, string>;
  /** Each photo-having row's own short-lived signed R2 GET url,
   * pre-resolved server-side (page.tsx, via students.ts's
   * `getStudentPhotoUrlsByIds`) — see StudentAvatar's own doc comment. */
  photoUrlByStudentId: Map<string, string>;
  canSubmit: boolean;
  canApprove: boolean;
}

function statusTone(status: string): "green" | "amber" | "gray" | "blue" | "red" {
  if (status === "published" || status === "approved") return "green";
  if (status === "under_review" || status === "requested") return "amber";
  if (status === "marks_entered" || status === "draft") return "blue";
  if (status === "rejected") return "red";
  return "gray";
}

/**
 * Minimal UI, grouped by exam. `submitResults`/`publishResults` are
 * bulk, per-exam actions (see lib/academies/results.ts's module comment
 * on the plural-vs-singular naming) — one button per exam moves every
 * eligible result in that exam forward at once. `approveResult`/
 * `rejectResult` are per-result decisions, so they get one button per row.
 */
export function ResultsList({ results, examNames, photoUrlByStudentId, canSubmit, canApprove }: Props) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [correctingId, setCorrectingId] = useState<string | null>(null);
  const [correctionReason, setCorrectionReason] = useState("");
  const [proposedMarks, setProposedMarks] = useState("");
  const rejectingRow = results.find((row) => row.id === rejectingId) ?? null;
  const correctingRow = results.find((row) => row.id === correctingId) ?? null;

  function cancelReject() {
    setRejectingId(null);
    setRejectReason("");
  }

  function cancelCorrection() {
    setCorrectingId(null);
    setCorrectionReason("");
    setProposedMarks("");
  }

  const byExam = new Map<string, ResultRosterRow[]>();
  for (const row of results) {
    const list = byExam.get(row.examId) ?? [];
    list.push(row);
    byExam.set(row.examId, list);
  }

  // Display-only lookup for CorrectionsPanel below — a correction's
  // `originalResultId` is a raw id with nothing human-readable of its own;
  // every result it can reference is already in `results` (corrections are
  // only ever requested against a `published` result, which `listResults`
  // still returns), so this is a free label resolution on data already on
  // the page, not a new query.
  const resultLabelById = new Map(
    results.map((row) => [row.id, `${row.studentFullName} (${row.studentNumber}) — ${examNames[row.examId] ?? "Unknown exam"}`]),
  );

  function run(action: () => Promise<{ ok: true } | { ok: false; error: { message: string } }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error.message);
    });
  }

  return (
    <div className="flex flex-col gap-6">
      {error && <ErrorMessage message={error} />}

      {correctingRow && (
        <FormDialog
          open={correctingId !== null}
          onOpenChange={(nextOpen) => !nextOpen && cancelCorrection()}
          title={`Request correction — ${correctingRow.studentFullName} (${correctingRow.studentNumber})`}
        >
          <div className="flex flex-col gap-3">
            <Field label="Proposed marks">
              <input
                type="number"
                value={proposedMarks}
                onChange={(event) => setProposedMarks(event.target.value)}
                className={inputClass}
              />
            </Field>
            <Field label="Reason">
              <input
                type="text"
                value={correctionReason}
                onChange={(event) => setCorrectionReason(event.target.value)}
                className={inputClass}
              />
            </Field>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={isPending || correctionReason.trim() === "" || proposedMarks.trim() === ""}
                onClick={() =>
                  run(async () => {
                    const result = await requestResultCorrection(correctingRow.id, {
                      reason: correctionReason,
                      proposedMarksObtained: Number(proposedMarks),
                    });
                    if (result.ok) cancelCorrection();
                    return result;
                  })
                }
              >
                Submit correction request
              </Button>
              <Button type="button" variant="secondary" onClick={cancelCorrection}>
                Cancel
              </Button>
            </div>
          </div>
        </FormDialog>
      )}

      {rejectingRow && (
        <FormDialog
          open={rejectingId !== null}
          onOpenChange={(nextOpen) => !nextOpen && cancelReject()}
          title={`Reject result — ${rejectingRow.studentFullName} (${rejectingRow.studentNumber})`}
        >
          <div className="flex flex-col gap-3">
            <Field label="Reason">
              <input
                type="text"
                value={rejectReason}
                onChange={(event) => setRejectReason(event.target.value)}
                className={inputClass}
              />
            </Field>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="danger"
                disabled={isPending || rejectReason.trim() === ""}
                onClick={() =>
                  run(async () => {
                    const result = await rejectResult(rejectingRow.id, rejectReason);
                    if (result.ok) cancelReject();
                    return result;
                  })
                }
              >
                Confirm reject
              </Button>
              <Button type="button" variant="secondary" onClick={cancelReject}>
                Cancel
              </Button>
            </div>
          </div>
        </FormDialog>
      )}

      {results.length === 0 && (
        <Section>
          <EmptyState message="No results yet." icon={<Icon name="fact_check" />} />
        </Section>
      )}
      {[...byExam.entries()].map(([examId, rows]) => {
        const hasMarksEntered = rows.some((row) => row.status === "marks_entered");
        const hasApproved = rows.some((row) => row.status === "approved");
        return (
          <Section key={examId}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-ink">{examNames[examId] ?? "Exam"}</h2>
              <div className="flex flex-wrap gap-2">
                {canSubmit && hasMarksEntered && (
                  <Button type="button" variant="secondary" disabled={isPending} onClick={() => run(() => submitResults(examId))}>
                    Submit marks for review
                  </Button>
                )}
                {canApprove && hasApproved && (
                  <Button type="button" disabled={isPending} onClick={() => run(() => publishResults(examId))}>
                    Publish approved results
                  </Button>
                )}
              </div>
            </div>
            <div className="mt-3">
              <TableWrap>
                <thead>
                  <tr>
                    <th className={th}>Student</th>
                    <th className={th}>Marks</th>
                    <th className={th}>Status</th>
                    <th className={th}>Grade</th>
                    {canApprove && <th className={th}>Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className={trHover}>
                      <td className={td}>
                        <div className="flex items-center gap-3">
                          <StudentAvatar
                            fullName={row.studentFullName}
                            photoUrl={photoUrlByStudentId.get(row.studentId) ?? null}
                            sizeClassName="h-8 w-8"
                          />
                          <div className="min-w-0">
                            <span className="block truncate font-medium text-ink">{row.studentFullName}</span>
                            <span className="block text-xs text-muted">{row.studentNumber}</span>
                          </div>
                        </div>
                      </td>
                      <td className={td}>{row.marksObtained ?? "—"}</td>
                      <td className={td}>
                        <Badge label={row.status} tone={statusTone(row.status)} />
                      </td>
                      <td className={td}>{row.gradeBandLabel ?? "—"}</td>
                      {canApprove && (
                        <td className={td}>
                          {row.status === "published" && (
                            <div className="flex flex-wrap items-center gap-2">
                              <Button
                                type="button"
                                variant="secondary"
                                className="px-2.5 py-1 text-xs"
                                disabled={isPending}
                                onClick={() => setCorrectingId(row.id)}
                              >
                                Request correction
                              </Button>
                            </div>
                          )}
                          {row.status === "under_review" && (
                            <div className="flex flex-wrap items-center gap-2">
                              <Button
                                type="button"
                                className="px-2.5 py-1 text-xs"
                                disabled={isPending}
                                onClick={() => run(() => approveResult(row.id))}
                              >
                                Approve
                              </Button>
                              <Button
                                type="button"
                                variant="danger"
                                className="px-2.5 py-1 text-xs"
                                disabled={isPending}
                                onClick={() => setRejectingId(row.id)}
                              >
                                Reject
                              </Button>
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            </div>
          </Section>
        );
      })}
      {canApprove && <CorrectionsPanel resultLabelById={resultLabelById} />}
    </div>
  );
}

/**
 * Item 50b: lists every result_corrections row for the academy and lets an
 * approve-capable actor (Owner/Admin/Manager — same `canApprove` gate the
 * parent list already checked before rendering this) decide `requested`
 * ones. Fetched on demand rather than passed down from the server
 * component, matching lib/academies/exams-actions.ts's
 * `getExamResultsRoster` "Server Action even for a read" convention.
 */
function CorrectionsPanel({ resultLabelById }: { resultLabelById: Map<string, string> }) {
  const [isPending, startTransition] = useTransition();
  const [corrections, setCorrections] = useState<ResultCorrectionRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const rejectingCorrection = corrections?.find((correction) => correction.id === rejectingId) ?? null;

  function cancelReject() {
    setRejectingId(null);
    setRejectReason("");
  }

  function refresh() {
    startTransition(async () => {
      const result = await getResultCorrectionsList();
      if (result.ok) {
        setCorrections(result.corrections);
      } else {
        setError(result.error.message);
      }
    });
  }

  useEffect(() => {
    refresh();
  }, []);

  function run(action: () => Promise<{ ok: true } | { ok: false; error: { message: string } }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      refresh();
    });
  }

  return (
    <Section>
      <h2 className="text-base font-semibold text-ink">Result correction requests</h2>
      {error && (
        <div className="mt-2">
          <ErrorMessage message={error} />
        </div>
      )}
      {rejectingCorrection && (
        <FormDialog
          open={rejectingId !== null}
          onOpenChange={(nextOpen) => !nextOpen && cancelReject()}
          title={`Reject correction request — ${resultLabelById.get(rejectingCorrection.originalResultId) ?? rejectingCorrection.originalResultId}`}
        >
          <div className="flex flex-col gap-3">
            <Field label="Reason">
              <input
                type="text"
                value={rejectReason}
                onChange={(event) => setRejectReason(event.target.value)}
                className={inputClass}
              />
            </Field>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="danger"
                disabled={isPending || rejectReason.trim() === ""}
                onClick={() =>
                  run(async () => {
                    const result = await rejectResultCorrection(rejectingCorrection.id, rejectReason);
                    if (result.ok) cancelReject();
                    return result;
                  })
                }
              >
                Confirm reject
              </Button>
              <Button type="button" variant="secondary" onClick={cancelReject}>
                Cancel
              </Button>
            </div>
          </div>
        </FormDialog>
      )}

      {!corrections && <p className="mt-2 text-sm text-muted">Loading...</p>}
      {corrections && corrections.length === 0 && <p className="mt-2 text-sm text-muted">No correction requests.</p>}
      {corrections && corrections.length > 0 && (
        <div className="mt-3">
          <TableWrap>
            <thead>
              <tr>
                <th className={th}>Student / Exam</th>
                <th className={th}>Proposed marks</th>
                <th className={th}>Reason</th>
                <th className={th}>Status</th>
                <th className={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {corrections.map((correction) => (
                <tr key={correction.id} className={trHover}>
                  <td className={`${td} font-medium`}>
                    {resultLabelById.get(correction.originalResultId) ?? correction.originalResultId}
                  </td>
                  <td className={td}>{correction.proposedMarksObtained ?? "—"}</td>
                  <td className={td}>{correction.reason}</td>
                  <td className={td}>
                    <Badge label={correction.status} tone={statusTone(correction.status)} />
                  </td>
                  <td className={td}>
                    {correction.status === "requested" && (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          className="px-2.5 py-1 text-xs"
                          disabled={isPending}
                          onClick={() => run(() => approveResultCorrection(correction.id))}
                        >
                          Approve
                        </Button>
                        <Button
                          type="button"
                          variant="danger"
                          className="px-2.5 py-1 text-xs"
                          disabled={isPending}
                          onClick={() => setRejectingId(correction.id)}
                        >
                          Reject
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </div>
      )}
    </Section>
  );
}
