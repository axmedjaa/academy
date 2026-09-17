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

interface Props {
  results: ResultRosterRow[];
  canSubmit: boolean;
  canApprove: boolean;
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
    <div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>
      {error && (
        <p role="alert" style={{ color: "crimson" }}>
          {error}
        </p>
      )}
      {results.length === 0 && <p>No results yet.</p>}
      {[...byExam.entries()].map(([examId, rows]) => {
        const hasMarksEntered = rows.some((row) => row.status === "marks_entered");
        const hasApproved = rows.some((row) => row.status === "approved");
        return (
          <section key={examId} style={{ border: "1px solid #ddd", padding: "1rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h2 style={{ margin: 0 }}>Exam {examId}</h2>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                {canSubmit && hasMarksEntered && (
                  <button type="button" disabled={isPending} onClick={() => run(() => submitResults(examId))}>
                    Submit marks for review
                  </button>
                )}
                {canApprove && hasApproved && (
                  <button type="button" disabled={isPending} onClick={() => run(() => publishResults(examId))}>
                    Publish approved results
                  </button>
                )}
              </div>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "0.75rem" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Student</th>
                  <th style={{ textAlign: "left" }}>Marks</th>
                  <th style={{ textAlign: "left" }}>Status</th>
                  <th style={{ textAlign: "left" }}>Grade</th>
                  {canApprove && <th />}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      {row.studentFullName} ({row.studentNumber})
                    </td>
                    <td>{row.marksObtained ?? "—"}</td>
                    <td>{row.status}</td>
                    <td>{row.gradeBandLabel ?? "—"}</td>
                    {canApprove && (
                      <td>
                        {row.status === "published" && (
                          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                            {correctingId === row.id ? (
                              <>
                                <input
                                  type="number"
                                  placeholder="Proposed marks"
                                  value={proposedMarks}
                                  onChange={(event) => setProposedMarks(event.target.value)}
                                  style={{ width: "7rem" }}
                                />
                                <input
                                  type="text"
                                  placeholder="Reason"
                                  value={correctionReason}
                                  onChange={(event) => setCorrectionReason(event.target.value)}
                                  style={{ width: "10rem" }}
                                />
                                <button
                                  type="button"
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
                                </button>
                              </>
                            ) : (
                              <button type="button" disabled={isPending} onClick={() => setCorrectingId(row.id)}>
                                Request correction
                              </button>
                            )}
                          </div>
                        )}
                        {row.status === "under_review" && (
                          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                            <button type="button" disabled={isPending} onClick={() => run(() => approveResult(row.id))}>
                              Approve
                            </button>
                            {rejectingId === row.id ? (
                              <>
                                <input
                                  type="text"
                                  placeholder="Reason"
                                  value={rejectReason}
                                  onChange={(event) => setRejectReason(event.target.value)}
                                  style={{ width: "10rem" }}
                                />
                                <button
                                  type="button"
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
                                </button>
                              </>
                            ) : (
                              <button type="button" disabled={isPending} onClick={() => setRejectingId(row.id)}>
                                Reject
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
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
    <section style={{ border: "1px solid #ddd", padding: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>Result correction requests</h2>
      {error && (
        <p role="alert" style={{ color: "crimson" }}>
          {error}
        </p>
      )}
      {!corrections && <p>Loading...</p>}
      {corrections && corrections.length === 0 && <p>No correction requests.</p>}
      {corrections && corrections.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Result</th>
              <th style={{ textAlign: "left" }}>Proposed marks</th>
              <th style={{ textAlign: "left" }}>Reason</th>
              <th style={{ textAlign: "left" }}>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {corrections.map((correction) => (
              <tr key={correction.id}>
                <td>{correction.originalResultId}</td>
                <td>{correction.proposedMarksObtained ?? "—"}</td>
                <td>{correction.reason}</td>
                <td>{correction.status}</td>
                <td>
                  {correction.status === "requested" && (
                    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                      <button
                        type="button"
                        disabled={isPending}
                        onClick={() => run(() => approveResultCorrection(correction.id))}
                      >
                        Approve
                      </button>
                      {rejectingId === correction.id ? (
                        <>
                          <input
                            type="text"
                            placeholder="Reason"
                            value={rejectReason}
                            onChange={(event) => setRejectReason(event.target.value)}
                            style={{ width: "10rem" }}
                          />
                          <button
                            type="button"
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
                          </button>
                        </>
                      ) : (
                        <button type="button" disabled={isPending} onClick={() => setRejectingId(correction.id)}>
                          Reject
                        </button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
