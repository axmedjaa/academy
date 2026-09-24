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
import { Badge, Button, ErrorMessage, Section, TableWrap, inputClass, td, th, trHover } from "@/app/academy/_shell/ui";

interface Props {
  results: ResultRosterRow[];
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
export function ResultsList({ results, canSubmit, canApprove }: Props) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [correctingId, setCorrectingId] = useState<string | null>(null);
  const [correctionReason, setCorrectionReason] = useState("");
  const [proposedMarks, setProposedMarks] = useState("");

  const byExam = new Map<string, ResultRosterRow[]>();
  for (const row of results) {
    const list = byExam.get(row.examId) ?? [];
    list.push(row);
    byExam.set(row.examId, list);
  }

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
      {results.length === 0 && (
        <Section>
          <p className="text-sm text-muted">No results yet.</p>
        </Section>
      )}
      {[...byExam.entries()].map(([examId, rows]) => {
        const hasMarksEntered = rows.some((row) => row.status === "marks_entered");
        const hasApproved = rows.some((row) => row.status === "approved");
        return (
          <Section key={examId}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-ink">Exam {examId}</h2>
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
                      <td className={`${td} font-medium`}>
                        {row.studentFullName} <span className="font-normal text-muted">({row.studentNumber})</span>
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
                              {correctingId === row.id ? (
                                <>
                                  <input
                                    type="number"
                                    placeholder="Proposed marks"
                                    value={proposedMarks}
                                    onChange={(event) => setProposedMarks(event.target.value)}
                                    className={`${inputClass} w-28 py-1.5`}
                                  />
                                  <input
                                    type="text"
                                    placeholder="Reason"
                                    value={correctionReason}
                                    onChange={(event) => setCorrectionReason(event.target.value)}
                                    className={`${inputClass} w-40 py-1.5`}
                                  />
                                  <Button
                                    type="button"
                                    variant="secondary"
                                    className="px-2.5 py-1 text-xs"
                                    disabled={isPending || correctionReason.trim() === "" || proposedMarks.trim() === ""}
                                    onClick={() =>
                                      run(async () => {
                                        const result = await requestResultCorrection(row.id, {
                                          reason: correctionReason,
                                          proposedMarksObtained: Number(proposedMarks),
                                        });
                                        if (result.ok) {
                                          setCorrectingId(null);
                                          setCorrectionReason("");
                                          setProposedMarks("");
                                        }
                                        return result;
                                      })
                                    }
                                  >
                                    Submit correction request
                                  </Button>
                                </>
                              ) : (
                                <Button
                                  type="button"
                                  variant="secondary"
                                  className="px-2.5 py-1 text-xs"
                                  disabled={isPending}
                                  onClick={() => setCorrectingId(row.id)}
                                >
                                  Request correction
                                </Button>
                              )}
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
                              {rejectingId === row.id ? (
                                <>
                                  <input
                                    type="text"
                                    placeholder="Reason"
                                    value={rejectReason}
                                    onChange={(event) => setRejectReason(event.target.value)}
                                    className={`${inputClass} w-40 py-1.5`}
                                  />
                                  <Button
                                    type="button"
                                    variant="danger"
                                    className="px-2.5 py-1 text-xs"
                                    disabled={isPending || rejectReason.trim() === ""}
                                    onClick={() =>
                                      run(async () => {
                                        const result = await rejectResult(row.id, rejectReason);
                                        if (result.ok) {
                                          setRejectingId(null);
                                          setRejectReason("");
                                        }
                                        return result;
                                      })
                                    }
                                  >
                                    Confirm reject
                                  </Button>
                                </>
                              ) : (
                                <Button
                                  type="button"
                                  variant="danger"
                                  className="px-2.5 py-1 text-xs"
                                  disabled={isPending}
                                  onClick={() => setRejectingId(row.id)}
                                >
                                  Reject
                                </Button>
                              )}
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
      {canApprove && <CorrectionsPanel />}
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
function CorrectionsPanel() {
  const [isPending, startTransition] = useTransition();
  const [corrections, setCorrections] = useState<ResultCorrectionRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

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
      {!corrections && <p className="mt-2 text-sm text-muted">Loading...</p>}
      {corrections && corrections.length === 0 && <p className="mt-2 text-sm text-muted">No correction requests.</p>}
      {corrections && corrections.length > 0 && (
        <div className="mt-3">
          <TableWrap>
            <thead>
              <tr>
                <th className={th}>Result</th>
                <th className={th}>Proposed marks</th>
                <th className={th}>Reason</th>
                <th className={th}>Status</th>
                <th className={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {corrections.map((correction) => (
                <tr key={correction.id} className={trHover}>
                  <td className={td}>{correction.originalResultId}</td>
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
                        {rejectingId === correction.id ? (
                          <>
                            <input
                              type="text"
                              placeholder="Reason"
                              value={rejectReason}
                              onChange={(event) => setRejectReason(event.target.value)}
                              className={`${inputClass} w-40 py-1.5`}
                            />
                            <Button
                              type="button"
                              variant="danger"
                              className="px-2.5 py-1 text-xs"
                              disabled={isPending || rejectReason.trim() === ""}
                              onClick={() =>
                                run(async () => {
                                  const result = await rejectResultCorrection(correction.id, rejectReason);
                                  if (result.ok) {
                                    setRejectingId(null);
                                    setRejectReason("");
                                  }
                                  return result;
                                })
                              }
                            >
                              Confirm reject
                            </Button>
                          </>
                        ) : (
                          <Button
                            type="button"
                            variant="danger"
                            className="px-2.5 py-1 text-xs"
                            disabled={isPending}
                            onClick={() => setRejectingId(correction.id)}
                          >
                            Reject
                          </Button>
                        )}
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
