"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { enterMarks } from "@/lib/academies/exams-actions";
import type { ExamRecord, ExamResultRecord } from "@/lib/academies/exams";
import { NETWORK_ERROR_MESSAGE } from "@/lib/ui/guard-action";
import { showSuccessToast } from "@/lib/ui/toast";
import { BackLink, Badge, PageHeader, humanizeStatus, trHover } from "@/app/academy/_shell/ui";
import { DataTable, NoteBlock, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";

/**
 * The mark sheet: one number per student, saved together with "Save marks"
 * through the existing all-or-nothing `enterMarks` (the server rejects the
 * whole save if any mark is invalid, above the maximum, or for a result
 * already past "marks entered"). Results that have moved on to review,
 * approval or publishing are read-only here.
 */

export interface MarksRow {
  resultId: string;
  studentId: string;
  name: string;
  number: string;
  marks: number | null;
  status: ExamResultRecord["status"];
  grade: string | null;
  passFail: ExamResultRecord["passFail"];
}

const EDITABLE = new Set<ExamResultRecord["status"]>(["draft", "marks_entered"]);

const STATUS_TONE: Record<ExamResultRecord["status"], "gray" | "blue" | "amber" | "green" | "red"> = {
  draft: "gray",
  marks_entered: "blue",
  submitted: "amber",
  under_review: "amber",
  approved: "green",
  rejected: "red",
  published: "green",
};

export function MarksSheet({
  exam,
  title,
  description,
  rows,
  canEnterMarks,
}: {
  exam: ExamRecord;
  title: string;
  description: string;
  rows: MarksRow[];
  canEnterMarks: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(rows.map((row) => [row.studentId, row.marks === null ? "" : String(row.marks)])),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);

  function check(studentId: string, value: string): string | null {
    if (value.trim() === "") return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return "Enter a mark of 0 or more.";
    if (n > exam.maxMarks) return `The maximum is ${exam.maxMarks}.`;
    return null;
  }

  function save() {
    const nextErrors: Record<string, string> = {};
    const entries: { studentId: string; marksObtained: number }[] = [];
    for (const row of rows) {
      if (!EDITABLE.has(row.status)) continue;
      const value = values[row.studentId] ?? "";
      const message = check(row.studentId, value);
      if (message) nextErrors[row.studentId] = message;
      else if (value.trim() !== "") entries.push({ studentId: row.studentId, marksObtained: Number(value) });
    }
    setErrors(nextErrors);
    const count = Object.keys(nextErrors).length;
    if (count > 0) {
      setBanner(count > 1 ? `${count} marks need attention. They are marked below.` : null);
      window.setTimeout(() => document.querySelector<HTMLInputElement>("[data-mark][aria-invalid=true]")?.focus(), 40);
      return;
    }
    if (entries.length === 0) {
      setBanner("Enter at least one mark before saving.");
      return;
    }
    setBanner(null);
    startTransition(async () => {
      try {
        const result = await enterMarks(exam.id, entries);
        if (!result.ok) {
          setBanner(result.error.message);
          return;
        }
        showSuccessToast(`Marks saved for ${entries.length} student${entries.length === 1 ? "" : "s"}.`);
        router.refresh();
      } catch {
        setBanner(NETWORK_ERROR_MESSAGE);
      }
    });
  }

  const editableCount = rows.filter((row) => EDITABLE.has(row.status)).length;

  return (
    <>
      <BackLink href="/academy/exams" label="All exams" />
      <PageHeader
        title={title}
        description={description}
        actions={
          canEnterMarks && editableCount > 0 ? (
            <button
              type="button"
              onClick={save}
              disabled={pending}
              className="inline-flex h-11 min-w-[120px] items-center justify-center rounded-lg bg-brand px-[18px] text-[15px] font-semibold text-white transition-colors duration-150 hover:bg-brand-hover disabled:opacity-60"
            >
              {pending ? "Saving…" : "Save marks"}
            </button>
          ) : undefined
        }
      />

      {banner && (
        <div role="alert" className="mb-4 rounded-lg border border-[#FECACA] bg-[#FEF2F2] px-3 py-2.5 text-[13px] text-[#991B1B]">
          {banner}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="mb-8 rounded-card border border-border bg-surface px-4 py-8 text-center text-sm text-muted shadow-card">
          No students take this course in the batch yet.
        </div>
      ) : (
        <DataTable stackBelow={600}>
          <thead>
            <tr>
              <th className={rtTh}>Student</th>
              <th className={rtTh}>ID</th>
              <th className={rtTh}>Mark</th>
              <th className={rtTh}>Grade</th>
              <th className={rtTh}>Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const editable = canEnterMarks && EDITABLE.has(row.status);
              const error = errors[row.studentId];
              return (
                <tr key={row.resultId} className={trHover}>
                  <td className={`${rtTd} font-semibold`} data-label="Student">
                    {row.name}
                  </td>
                  <td className={`${rtTd} tabular-nums text-muted`} data-label="ID">
                    {row.number}
                  </td>
                  <td className={rtTd} data-label="Mark">
                    {editable ? (
                      <span className="inline-flex flex-col gap-1">
                        <input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          max={exam.maxMarks}
                          step="any"
                          data-mark=""
                          aria-label={`Mark for ${row.name}, out of ${exam.maxMarks}`}
                          aria-invalid={error ? true : undefined}
                          aria-describedby={error ? `mark-${row.studentId}` : undefined}
                          value={values[row.studentId] ?? ""}
                          onChange={(event) => setValues((current) => ({ ...current, [row.studentId]: event.target.value }))}
                          onBlur={(event) =>
                            setErrors((current) => {
                              const next = { ...current };
                              const message = check(row.studentId, event.target.value);
                              if (message) next[row.studentId] = message;
                              else delete next[row.studentId];
                              return next;
                            })
                          }
                          className={`h-11 w-24 rounded-lg border bg-surface px-3 text-center text-[15px] tabular-nums text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20 ${
                            error ? "border-[#B91C1C]" : "border-border-strong"
                          }`}
                        />
                        {error && (
                          <span id={`mark-${row.studentId}`} role="alert" className="text-xs font-medium text-[#B91C1C]">
                            {error}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="tabular-nums">{row.marks === null ? "Not entered" : `${row.marks} / ${exam.maxMarks}`}</span>
                    )}
                  </td>
                  <td className={rtTd} data-label="Grade">
                    {row.status === "published" && row.grade ? (
                      <span className="font-semibold">
                        {row.grade}
                        {row.passFail !== "pending" && row.grade.trim().toLowerCase() !== row.passFail ? ` (${row.passFail})` : ""}
                      </span>
                    ) : (
                      <span className="text-muted">After publishing</span>
                    )}
                  </td>
                  <td className={rtTd} data-label="Result">
                    <Badge label={humanizeStatus(row.status)} tone={STATUS_TONE[row.status]} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}

      <NoteBlock>
        Save marks saves every filled mark at once. There is no separate draft control. Submit for review and publishing
        happen on the Results page.
      </NoteBlock>
    </>
  );
}
