"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateBatchCourseDatesAction } from "@/lib/academies/batches-actions";
import { formatDate } from "@/lib/ui/date";
import { showSuccessToast } from "@/lib/ui/toast";
import { NETWORK_ERROR_MESSAGE } from "@/lib/ui/guard-action";
import {
  DField,
  DesignDialog,
  DialogBody,
  DialogFooter,
  FieldGrid,
  FormErrorBanner,
  FormSummary,
  controlClass,
  invalidProps,
} from "@/app/academy/_shell/design-form";
import { rtTd } from "@/app/academy/_shell/page-blocks";

/**
 * The Start date / End date cells of one row in "Courses in this batch", plus
 * (for staff who can edit the batch) a "Set dates" / "Edit dates" link in its
 * own column that opens the design's "Dates for <course>" dialog (A08
 * `courseDates`): the course, its length and how many other courses the
 * batch has; Start and End date, both required; a "Course length, N weeks"
 * quick fill, and the end date follows the start until it is changed by
 * hand. Clear dates removes both. The server (updateBatchCourseDates)
 * re-checks permission, branch scope, that the course is in this batch, and
 * that the end isn't before the start.
 */
export function CourseDateCells({
  startDate,
  endDate,
}: {
  startDate: string | null;
  endDate: string | null;
}) {
  return (
    <>
      <td className={`${rtTd} whitespace-nowrap`} data-label="Start date">
        {startDate ? (
          formatDate(startDate)
        ) : (
          <span className="text-muted">Not set</span>
        )}
      </td>
      <td className={`${rtTd} whitespace-nowrap`} data-label="End date">
        {endDate ? (
          formatDate(endDate)
        ) : (
          <span className="text-muted">Not set</span>
        )}
      </td>
    </>
  );
}

/** The row's last cell: "Set dates" / "Edit dates" and its dialog. */
export function CourseDatesAction({
  batchId,
  batchCode,
  courseId,
  courseName,
  durationWeeks,
  otherCourses,
  startDate,
  endDate,
}: {
  batchId: string;
  batchCode: string;
  courseId: string;
  courseName: string;
  durationWeeks: number | null;
  otherCourses: number;
  startDate: string | null;
  endDate: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <td className={rtTd} data-actions="">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`${startDate || endDate ? "Edit" : "Set"} the dates of ${courseName}`}
        className="inline-flex min-h-11 items-center whitespace-nowrap font-semibold text-brand hover:underline"
      >
        {startDate || endDate ? "Edit dates" : "Set dates"}
      </button>
      <DesignDialog
        open={open}
        onOpenChange={setOpen}
        title={`Dates for ${courseName}`}
        description={`Batch ${batchCode}. This course has its own start and end date.${durationWeeks ? " The end date follows the course length, and you can change it." : ""}`}
        width={640}
      >
        {open && (
          <DatesForm
            batchId={batchId}
            courseId={courseId}
            courseName={courseName}
            durationWeeks={durationWeeks}
            otherCourses={otherCourses}
            startDate={startDate}
            endDate={endDate}
            onDone={() => setOpen(false)}
          />
        )}
      </DesignDialog>
    </td>
  );
}

/** Start date + length in weeks -> the last day of the course (YYYY-MM-DD). */
function endFromLength(start: string, weeks: number | null): string {
  if (!weeks || !/^\d{4}-\d{2}-\d{2}$/.test(start)) return "";
  const [y, m, d] = start.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + weeks * 7 - 1));
  return date.toISOString().slice(0, 10);
}

function DatesForm({
  batchId,
  courseId,
  courseName,
  durationWeeks,
  otherCourses,
  startDate,
  endDate,
  onDone,
}: {
  batchId: string;
  courseId: string;
  courseName: string;
  durationWeeks: number | null;
  otherCourses: number;
  startDate: string | null;
  endDate: string | null;
  onDone: () => void;
}) {
  const router = useRouter();
  const [start, setStart] = useState(startDate ?? "");
  const [end, setEnd] = useState(endDate ?? "");
  // The end date follows the start (course length) until it is set by hand.
  const [endTouched, setEndTouched] = useState(Boolean(endDate));
  const [errors, setErrors] = useState<{ start?: string; end?: string }>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const suggested = endFromLength(start, durationWeeks);

  function send(nextStart: string, nextEnd: string, message: string) {
    startTransition(async () => {
      try {
        const result = await updateBatchCourseDatesAction({
          batchId,
          courseId,
          startDate: nextStart,
          endDate: nextEnd,
        });
        if (!result.ok) {
          setBanner(result.error?.message ?? "The dates couldn't be saved.");
          return;
        }
        showSuccessToast(message);
        onDone();
        router.refresh();
      } catch {
        setBanner(NETWORK_ERROR_MESSAGE);
      }
    });
  }

  return (
    <form
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        const next: typeof errors = {};
        if (!start) next.start = "Start date is required.";
        if (!end) next.end = "End date is required.";
        else if (start && end < start)
          next.end = "The end date can't be before the start date.";
        setErrors(next);
        if (Object.keys(next).length) return;
        send(start, end, `Dates saved for ${courseName}.`);
      }}
    >
      <DialogBody>
        <FormSummary
          items={[
            { label: "Course", value: courseName },
            {
              label: "Course length",
              value: durationWeeks ? `${durationWeeks} weeks` : "Not set",
            },
            {
              label: "Other courses in this batch",
              value: String(otherCourses),
            },
          ]}
        />
        <FieldGrid>
          <DField label="Start date" name="start" required error={errors.start}>
            <input
              type="date"
              value={start}
              onChange={(event) => {
                const value = event.target.value;
                setStart(value);
                setErrors((current) => ({ ...current, start: undefined }));
                if (!endTouched) setEnd(endFromLength(value, durationWeeks));
              }}
              className={controlClass(Boolean(errors.start))}
              {...invalidProps("start", errors.start)}
            />
          </DField>
          <DField label="End date" name="end" required error={errors.end}>
            <input
              type="date"
              value={end}
              min={start || undefined}
              onChange={(event) => {
                setEnd(event.target.value);
                setEndTouched(true);
                setErrors((current) => ({ ...current, end: undefined }));
              }}
              className={controlClass(Boolean(errors.end))}
              {...invalidProps("end", errors.end)}
            />
            {suggested && suggested !== end && (
              <button
                type="button"
                onClick={() => {
                  setEnd(suggested);
                  setEndTouched(false);
                  setErrors((current) => ({ ...current, end: undefined }));
                }}
                className="mt-2 inline-flex min-h-11 items-center self-start rounded-full border border-brand px-4 text-sm font-semibold text-brand hover:bg-brand-tint"
              >
                Course length, {durationWeeks} weeks
              </button>
            )}
          </DField>
        </FieldGrid>
        {(startDate || endDate) && (
          <button
            type="button"
            disabled={pending}
            onClick={() => send("", "", `Dates cleared for ${courseName}.`)}
            className="mt-4 inline-flex min-h-11 items-center text-sm font-semibold text-muted hover:text-ink hover:underline disabled:opacity-60"
          >
            Clear dates (show “Not set”)
          </button>
        )}
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter
        onCancel={onDone}
        submitLabel="Save dates"
        pendingLabel="Saving…"
        pending={pending}
      />
    </form>
  );
}
