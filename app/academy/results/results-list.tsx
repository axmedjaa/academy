"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { approveResult, publishResults, rejectResult, submitResults } from "@/lib/academies/results-actions";
import {
  approveResultCorrection,
  rejectResultCorrection,
  requestResultCorrection,
} from "@/lib/academies/result-corrections-actions";
import type { ResultCorrectionRecord } from "@/lib/academies/result-corrections";
import type { ResultRecord } from "@/lib/academies/results";
import { NETWORK_ERROR_MESSAGE } from "@/lib/ui/guard-action";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";
import { Badge, EmptyState, PageHeader, Section, humanizeStatus, trHover } from "@/app/academy/_shell/ui";
import { BlockTitle, DataTable, NoteBlock, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
import { Icon } from "@/app/academy/_shell/icons";
import { ConfirmButton } from "@/app/academy/_shell/confirm-dialog";
import {
  DField,
  DesignDialog,
  DialogBody,
  DialogFooter,
  FieldGrid,
  FormErrorBanner,
  controlClass,
  fieldControlArea,
  invalidProps,
} from "@/app/academy/_shell/design-form";

/**
 * Results (design A12): search and status chips (with counts) across every
 * exam, then one section per exam with "Submit marks for review" and
 * "Publish approved results", its results table (Approve on a result under
 * review, Request correction on a published one), "Reject a result under
 * review", and the Corrections table. All transitions are the existing
 * server actions; grades are fixed from the active configuration when
 * published, and published results change only through a correction.
 */

export interface ResultsExam {
  id: string;
  title: string;
  maxMarks: number;
  examDate: string | null;
}

export interface ResultsRow {
  id: string;
  examId: string;
  studentId: string;
  studentName: string;
  studentNumber: string;
  marks: number | null;
  status: ResultRecord["status"];
  grade: string | null;
  passFail: ResultRecord["passFail"];
}

const CHIPS: { key: string; label: string; statuses: ResultRecord["status"][] }[] = [
  { key: "draft", label: "Draft", statuses: ["draft", "rejected"] },
  { key: "marks_entered", label: "Marks entered", statuses: ["marks_entered"] },
  { key: "under_review", label: "Under review", statuses: ["submitted", "under_review"] },
  { key: "approved", label: "Approved", statuses: ["approved"] },
  { key: "published", label: "Published", statuses: ["published"] },
];

const TONE: Record<ResultRecord["status"], "gray" | "blue" | "amber" | "green" | "red"> = {
  draft: "gray",
  rejected: "gray",
  marks_entered: "blue",
  submitted: "amber",
  under_review: "amber",
  approved: "green",
  published: "green",
};

const ROW_BTN =
  "inline-flex h-10 items-center whitespace-nowrap rounded-lg border border-border-strong bg-surface px-3.5 text-[13px] font-semibold text-ink transition-colors duration-150 hover:bg-app disabled:cursor-not-allowed disabled:opacity-50";
const HEAD_BTN =
  "inline-flex h-10 items-center whitespace-nowrap rounded-lg border border-border-strong bg-surface px-3.5 text-[13px] font-semibold text-ink transition-colors duration-150 hover:bg-app disabled:cursor-not-allowed disabled:opacity-50";

/** "B (pass)"; just "Pass" when the band name already says it. */
function gradeText(grade: string, passFail: ResultRecord["passFail"]) {
  const verdict = passFail === "pass" ? "pass" : passFail === "fail" ? "fail" : null;
  return verdict && grade.trim().toLowerCase() !== verdict ? `${grade} (${verdict})` : grade;
}

type Outcome = { ok: true } | { ok: false; error: { message: string } };

export function ResultsList({
  exams,
  results,
  corrections,
  canSubmit,
  canApprove,
}: {
  exams: ResultsExam[];
  results: ResultsRow[];
  /** null when the caller can't see corrections. */
  corrections: ResultCorrectionRecord[] | null;
  canSubmit: boolean;
  canApprove: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [query, setQuery] = useState("");
  const [chip, setChip] = useState("all");
  const [publishFor, setPublishFor] = useState<ResultsExam | null>(null);
  const [rejectFor, setRejectFor] = useState<ResultsExam | null>(null);
  const [correctFor, setCorrectFor] = useState<ResultsRow | null>(null);

  const counts = useMemo(
    () => Object.fromEntries(CHIPS.map((c) => [c.key, results.filter((r) => c.statuses.includes(r.status)).length])),
    [results],
  );
  const needle = query.trim().toLowerCase();
  const chipStatuses = CHIPS.find((c) => c.key === chip)?.statuses;
  const visible = (row: ResultsRow) =>
    (!chipStatuses || chipStatuses.includes(row.status)) &&
    (!needle || row.studentName.toLowerCase().includes(needle) || row.studentNumber.toLowerCase().includes(needle));
  const filtering = Boolean(needle) || chip !== "all";
  const resultById = new Map(results.map((r) => [r.id, r]));
  const examById = new Map(exams.map((e) => [e.id, e]));

  function run(action: () => Promise<Outcome>, success: string) {
    start(async () => {
      try {
        const outcome = await action();
        if (!outcome.ok) {
          showErrorToast(outcome.error.message);
          return;
        }
        showSuccessToast(success);
        router.refresh();
      } catch {
        showErrorToast(NETWORK_ERROR_MESSAGE);
      }
    });
  }

  const shownExams = exams.filter((exam) => !filtering || results.some((r) => r.examId === exam.id && visible(r)));

  return (
    <section className="flex flex-col">
      <PageHeader title="Results" description="Marks by exam. Review, approve and publish here." />

      {exams.length === 0 ? (
        <Section>
          <EmptyState message="No results yet. They appear here once an exam has students." icon={<Icon name="clipboard" />} />
        </Section>
      ) : (
        <>
          <div className="mb-6 flex flex-col gap-3">
            <label className="relative block w-full max-w-[380px]">
              <span className="sr-only">Search student</span>
              <span aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">
                <Icon name="search" width={18} height={18} />
              </span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search student"
                className={`${controlClass(false)} pl-10`}
              />
            </label>
            <div role="group" aria-label="Filter by status" className="flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl bg-[#EEF0F3] p-1">
              {[{ key: "all", label: "All" }, ...CHIPS].map((c) => {
                const on = chip === c.key;
                return (
                  <button
                    key={c.key}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setChip(c.key)}
                    className={`inline-flex min-h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3.5 text-[13px] font-semibold transition-colors duration-150 ${
                      on ? "bg-surface text-brand shadow-card" : "text-[#374151] hover:text-ink"
                    }`}
                  >
                    {c.label}
                    {c.key !== "all" && (
                      <span className="rounded-full bg-surface/70 px-1.5 text-xs tabular-nums text-muted">{counts[c.key]}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {shownExams.length === 0 && (
            <div className="mb-8 rounded-card border border-border bg-surface px-4 py-8 text-center text-sm text-muted shadow-card">
              No results match this search.
            </div>
          )}

          {shownExams.map((exam) => {
            const rows = results.filter((r) => r.examId === exam.id);
            const shown = rows.filter(visible);
            const entered = rows.filter((r) => r.status === "marks_entered").length;
            const approved = rows.filter((r) => r.status === "approved").length;
            const underReview = rows.filter((r) => r.status === "under_review" || r.status === "submitted");
            return (
              <div key={exam.id} className="mb-2">
                <BlockTitle
                  actions={
                    <span className="flex flex-wrap gap-2">
                      {canSubmit && (
                        <button
                          type="button"
                          className={HEAD_BTN}
                          disabled={pending || entered === 0}
                          title={entered === 0 ? "No entered marks to submit." : undefined}
                          onClick={() => run(() => submitResults(exam.id), `Submitted ${entered} for review.`)}
                        >
                          Submit marks for review{entered > 0 ? ` (${entered})` : ""}
                        </button>
                      )}
                      {canApprove && (
                        <button
                          type="button"
                          className={HEAD_BTN}
                          disabled={pending || approved === 0}
                          title={approved === 0 ? "No approved results to publish." : undefined}
                          onClick={() => setPublishFor(exam)}
                        >
                          Publish approved results{approved > 0 ? ` (${approved})` : ""}
                        </button>
                      )}
                    </span>
                  }
                >
                  {exam.title}
                </BlockTitle>
                <DataTable stackBelow={760}>
                  <thead>
                    <tr>
                      <th className={rtTh}>Student</th>
                      <th className={`${rtTh} md:text-right`}>Marks</th>
                      <th className={rtTh}>Status</th>
                      <th className={rtTh}>Grade</th>
                      <th className={rtTh}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((row) => (
                      <tr key={row.id} className={trHover}>
                        <td className={rtTd} data-label="Student">
                          <span className="block font-semibold">{row.studentName}</span>
                          <span className="block text-xs text-muted">{row.studentNumber}</span>
                        </td>
                        <td className={`${rtTd} tabular-nums md:text-right`} data-label="Marks">
                          {row.marks === null ? <span className="text-muted">Not entered</span> : `${row.marks} / ${exam.maxMarks}`}
                        </td>
                        <td className={rtTd} data-label="Status">
                          <Badge label={humanizeStatus(row.status)} tone={TONE[row.status]} />
                        </td>
                        <td className={rtTd} data-label="Grade">
                          {row.status === "published" && row.grade ? (
                            gradeText(row.grade, row.passFail)
                          ) : (
                            <span className="text-muted">After publishing</span>
                          )}
                        </td>
                        <td className={rtTd} data-actions="">
                          {(row.status === "under_review" || row.status === "submitted") && canApprove ? (
                            <button
                              type="button"
                              className={ROW_BTN}
                              disabled={pending}
                              onClick={() => run(() => approveResult(row.id), `${row.studentName}'s result approved.`)}
                            >
                              Approve
                            </button>
                          ) : row.status === "published" && corrections !== null ? (
                            <button type="button" className={ROW_BTN} onClick={() => setCorrectFor(row)}>
                              Request correction
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </DataTable>
                {canApprove && underReview.length > 0 && (
                  <button type="button" onClick={() => setRejectFor(exam)} className={`${HEAD_BTN} -mt-4 mb-8 h-11 px-4 text-sm`}>
                    Reject a result under review
                  </button>
                )}
              </div>
            );
          })}
        </>
      )}

      {corrections !== null && corrections.length > 0 && (
        <>
          <BlockTitle>Corrections</BlockTitle>
          <DataTable stackBelow={900}>
            <thead>
              <tr>
                <th className={rtTh}>Student</th>
                <th className={rtTh}>Exam</th>
                <th className={`${rtTh} md:text-right`}>Original</th>
                <th className={`${rtTh} md:text-right`}>Proposed</th>
                <th className={rtTh}>Reason</th>
                <th className={rtTh}>Status</th>
                <th className={rtTh}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {corrections.map((c) => {
                const original = resultById.get(c.originalResultId);
                return (
                  <tr key={c.id} className={trHover}>
                    <td className={`${rtTd} font-semibold`} data-label="Student">
                      {original?.studentName ?? "Student"}
                    </td>
                    <td className={rtTd} data-label="Exam">
                      {original ? examById.get(original.examId)?.title ?? "Exam" : "Exam"}
                    </td>
                    <td className={`${rtTd} tabular-nums md:text-right`} data-label="Original">
                      {original?.marks ?? "Not available"}
                    </td>
                    <td className={`${rtTd} tabular-nums md:text-right`} data-label="Proposed">
                      {c.proposedMarksObtained ?? "No change"}
                    </td>
                    <td className={`${rtTd} max-w-[280px]`} data-label="Reason">
                      {c.reason}
                    </td>
                    <td className={rtTd} data-label="Status">
                      <Badge
                        label={c.status === "requested" ? "Pending approval" : humanizeStatus(c.status)}
                        tone={c.status === "requested" ? "amber" : c.status === "rejected" ? "gray" : "green"}
                      />
                    </td>
                    <td className={rtTd} data-actions="">
                      {c.status === "requested" && (
                        <span className="inline-flex gap-2">
                          <button
                            type="button"
                            className={ROW_BTN}
                            disabled={pending}
                            onClick={() => run(() => approveResultCorrection(c.id), "Correction approved and applied.")}
                          >
                            Approve
                          </button>
                          <RejectCorrectionButton correctionId={c.id} onDone={() => router.refresh()} />
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        </>
      )}

      <NoteBlock>
        Submitting moves entered marks to review. Rejecting a result returns its mark to draft for the trainer to fix.
        Publishing fixes each grade from the active grade configuration; after that a result changes only through a
        correction.
      </NoteBlock>

      {publishFor && (
        <ConfirmButton
          label="Publish"
          variant="primary"
          icon="check_circle"
          open
          onOpenChange={(open) => !open && setPublishFor(null)}
          title={`Publish approved results for ${publishFor.title}?`}
          description={<>Grades are fixed using the active configuration now. Published results change only through a correction.</>}
          successMessage="Results published."
          onConfirm={() => publishResults(publishFor.id)}
          onSuccess={() => router.refresh()}
        />
      )}
      {rejectFor && (
        <RejectResultDialog
          exam={rejectFor}
          rows={results.filter((r) => r.examId === rejectFor.id && (r.status === "under_review" || r.status === "submitted"))}
          onClose={() => setRejectFor(null)}
          onDone={() => {
            setRejectFor(null);
            router.refresh();
          }}
        />
      )}
      {correctFor && (
        <CorrectionDialog
          row={correctFor}
          maxMarks={examById.get(correctFor.examId)?.maxMarks ?? 100}
          onClose={() => setCorrectFor(null)}
          onDone={() => {
            setCorrectFor(null);
            router.refresh();
          }}
        />
      )}
    </section>
  );
}

function RejectResultDialog({
  exam,
  rows,
  onClose,
  onDone,
}: {
  exam: ResultsExam;
  rows: ResultsRow[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [resultId, setResultId] = useState(rows.length === 1 ? rows[0].id : "");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <DesignDialog open onOpenChange={(open) => !open && onClose()} title="Reject result" description={`The mark returns to draft for the trainer to fix. ${exam.title}.`}>
      <form
        noValidate
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          const next: Record<string, string> = {};
          if (!resultId) next.resultId = "Choose student.";
          if (!reason.trim()) next.reason = "Give a reason so the trainer knows what to fix.";
          setErrors(next);
          setBanner(Object.keys(next).length > 1 ? "2 fields need attention. They are marked below." : null);
          if (Object.keys(next).length) return;
          start(async () => {
            try {
              const outcome = await rejectResult(resultId, reason.trim());
              if (!outcome.ok) {
                setBanner(outcome.error.message);
                return;
              }
              showSuccessToast("Result rejected and returned to draft.");
              onDone();
            } catch {
              setBanner(NETWORK_ERROR_MESSAGE);
            }
          });
        }}
      >
        <DialogBody>
          <FieldGrid>
            <DField label="Student" name="resultId" required error={errors.resultId} full>
              <select value={resultId} onChange={(event) => setResultId(event.target.value)} className={controlClass(Boolean(errors.resultId))} {...invalidProps("resultId", errors.resultId)}>
                <option value="">Choose a student</option>
                {rows.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.studentName} ({row.marks ?? "no mark"})
                  </option>
                ))}
              </select>
            </DField>
            <DField label="Reason" name="reason" required error={errors.reason} full>
              <textarea
                rows={3}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                className={`${fieldControlArea} ${errors.reason ? "border-[#B91C1C]" : "border-border-strong"} min-h-[88px]`}
                {...invalidProps("reason", errors.reason)}
              />
            </DField>
          </FieldGrid>
          <FormErrorBanner message={banner} />
        </DialogBody>
        <DialogFooter onCancel={onClose} submitLabel="Reject" pendingLabel="Rejecting…" pending={pending} danger />
      </form>
    </DesignDialog>
  );
}

function CorrectionDialog({
  row,
  maxMarks,
  onClose,
  onDone,
}: {
  row: ResultsRow;
  maxMarks: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [marks, setMarks] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <DesignDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Request correction"
      description={`${row.studentName}, currently ${row.marks ?? "no mark"} / ${maxMarks}. The original mark stays in the audit log.`}
    >
      <form
        noValidate
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          const next: Record<string, string> = {};
          const n = Number(marks);
          if (marks.trim() === "" || !Number.isFinite(n) || n < 0) next.marks = "Enter the proposed mark (0 or more).";
          else if (n > maxMarks) next.marks = `The maximum is ${maxMarks}.`;
          if (!reason.trim()) next.reason = "Reason is required.";
          setErrors(next);
          setBanner(Object.keys(next).length > 1 ? "2 fields need attention. They are marked below." : null);
          if (Object.keys(next).length) return;
          start(async () => {
            try {
              const outcome = await requestResultCorrection(row.id, { proposedMarksObtained: n, reason: reason.trim() });
              if (!outcome.ok) {
                setBanner(outcome.error.message);
                return;
              }
              showSuccessToast("Correction requested.");
              onDone();
            } catch {
              setBanner(NETWORK_ERROR_MESSAGE);
            }
          });
        }}
      >
        <DialogBody>
          <FieldGrid>
            <DField label="Proposed marks" name="marks" required error={errors.marks}>
              <input
                type="number"
                inputMode="decimal"
                min={0}
                max={maxMarks}
                step="any"
                value={marks}
                onChange={(event) => setMarks(event.target.value)}
                className={controlClass(Boolean(errors.marks))}
                {...invalidProps("marks", errors.marks)}
              />
            </DField>
            <DField label="Reason" name="reason" required error={errors.reason} full>
              <textarea
                rows={3}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                className={`${fieldControlArea} ${errors.reason ? "border-[#B91C1C]" : "border-border-strong"} min-h-[88px]`}
                {...invalidProps("reason", errors.reason)}
              />
            </DField>
          </FieldGrid>
          <FormErrorBanner message={banner} />
        </DialogBody>
        <DialogFooter onCancel={onClose} submitLabel="Send request" pendingLabel="Sending…" pending={pending} />
      </form>
    </DesignDialog>
  );
}

function RejectCorrectionButton({ correctionId, onDone }: { correctionId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <>
      <button type="button" className={ROW_BTN} onClick={() => setOpen(true)}>
        Reject
      </button>
      <DesignDialog open={open} onOpenChange={setOpen} title="Reject correction" description="The published result stays as it is.">
        <form
          noValidate
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (!reason.trim()) {
              setError("Reason is required.");
              return;
            }
            setError(null);
            start(async () => {
              try {
                const outcome = await rejectResultCorrection(correctionId, reason.trim());
                if (!outcome.ok) {
                  setBanner(outcome.error.message);
                  return;
                }
                showSuccessToast("Correction rejected.");
                setOpen(false);
                onDone();
              } catch {
                setBanner(NETWORK_ERROR_MESSAGE);
              }
            });
          }}
        >
          <DialogBody>
            <DField label="Reason" name="reason" required error={error ?? undefined} full>
              <textarea
                rows={3}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                className={`${fieldControlArea} ${error ? "border-[#B91C1C]" : "border-border-strong"} min-h-[88px]`}
                {...invalidProps("reason", error ?? undefined)}
              />
            </DField>
            <FormErrorBanner message={banner} />
          </DialogBody>
          <DialogFooter onCancel={() => setOpen(false)} submitLabel="Reject" pendingLabel="Rejecting…" pending={pending} danger />
        </form>
      </DesignDialog>
    </>
  );
}
