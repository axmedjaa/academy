"use client";

import { startTransition, useActionState, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createExam, deleteExam, setExamStatus, type ExamFormState } from "@/lib/academies/exams-actions";
import type { ExamRecord } from "@/lib/academies/exams";
import { formatDate } from "@/lib/ui/date";
import { guardAction } from "@/lib/ui/guard-action";
import { showSuccessToast } from "@/lib/ui/toast";
import { Badge, Button, EmptyState, PageHeader, Section, humanizeStatus, trHover } from "@/app/academy/_shell/ui";
import { DataTable, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
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
  invalidProps,
  onDesignSubmit,
  useDesignForm,
  type DesignFormRule,
} from "@/app/academy/_shell/design-form";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Exams (design A10): header with Create exam, the Exam / Batch · course /
 * Max marks / Date / Status table with a Marks link to each exam's mark
 * sheet, and Archive / Restore / Delete kept in the row menu. An exam
 * belongs to one course of its batch; only students taking that course get
 * marks. Every action is the existing server action (permission, scope and
 * the active grade configuration are checked there).
 */

export interface ExamBatchOption {
  id: string;
  code: string;
  name: string;
  status: string;
  courses: { id: string; name: string }[];
}

interface Props {
  exams: (ExamRecord & { hasResults: boolean })[];
  batches: ExamBatchOption[];
  courseNames: Record<string, string>;
  canManage: boolean;
  canEnterMarks: boolean;
}

const EXAM_TONE: Record<ExamRecord["status"], "blue" | "amber" | "green" | "gray"> = {
  scheduled: "blue",
  marks_entry: "amber",
  completed: "green",
  archived: "gray",
};

const ROW_LINK = "inline-flex min-h-11 items-center font-semibold !text-brand no-underline hover:underline";

export function ExamsList({ exams, batches, courseNames, canManage, canEnterMarks }: Props) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [archiveRowId, setArchiveRowId] = useState<string | null>(null);
  const [deleteRowId, setDeleteRowId] = useState<string | null>(null);
  const batchById = new Map(batches.map((batch) => [batch.id, batch]));

  return (
    <section className="flex flex-col">
      <PageHeader
        title="Exams"
        description="Exams per batch. Enter marks on the exam, then submit them from Results."
        actions={
          canManage ? (
            <Button type="button" onClick={() => setCreateOpen(true)}>
              Create exam
            </Button>
          ) : undefined
        }
      />

      {exams.length === 0 ? (
        <Section>
          <EmptyState
            message={canManage ? "No exams yet. Create one for a course in a batch." : "No exams yet."}
            icon={<Icon name="fact_check" />}
          />
        </Section>
      ) : (
        <DataTable stackBelow={760}>
          <thead>
            <tr>
              <th className={rtTh}>Exam</th>
              <th className={rtTh}>Batch</th>
              <th className={`${rtTh} text-right`}>Max marks</th>
              <th className={rtTh}>Date</th>
              <th className={rtTh}>Status</th>
              <th className={rtTh}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {exams.map((exam) => {
              const batch = batchById.get(exam.batchId);
              return (
                <tr key={exam.id} className={trHover}>
                  <td className={`${rtTd} font-semibold`} data-label="Exam">
                    {exam.name}
                  </td>
                  <td className={rtTd} data-label="Batch">
                    {batch ? batch.code : "Batch"} · {courseNames[exam.courseId] ?? "Course"}
                  </td>
                  <td className={`${rtTd} tabular-nums md:text-right`} data-label="Max marks">
                    {exam.maxMarks}
                  </td>
                  <td className={`${rtTd} tabular-nums`} data-label="Date">
                    {formatDate(exam.examDate, "Not set")}
                  </td>
                  <td className={rtTd} data-label="Status">
                    <Badge label={humanizeStatus(exam.status)} tone={EXAM_TONE[exam.status]} />
                  </td>
                  <td className={rtTd} data-actions="">
                    <span className="inline-flex items-center gap-1">
                      <Link href={`/academy/exams/${exam.id}`} className={ROW_LINK}>
                        {canEnterMarks && exam.status !== "archived" ? "Marks" : "View marks"}
                      </Link>
                      {canManage && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              aria-label={`More actions for ${exam.name}`}
                              className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-muted transition-colors duration-150 hover:bg-app hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                            >
                              <Icon name="more" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setArchiveRowId(exam.id)}>
                              {exam.status === "archived" ? "Restore" : "Archive"}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {exam.hasResults ? (
                              <DropdownMenuItem
                                disabled
                                title="This exam has student results, so it can't be deleted. Archive it instead."
                              >
                                Delete
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem variant="destructive" onClick={() => setDeleteRowId(exam.id)}>
                                Delete
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </span>
                    {canManage && (
                      <ConfirmButton
                        label={exam.status === "archived" ? "Restore" : "Archive"}
                        variant={exam.status === "archived" ? "success" : "danger"}
                        icon={exam.status === "archived" ? "autorenew" : "archive"}
                        open={archiveRowId === exam.id}
                        onOpenChange={(open) => setArchiveRowId(open ? exam.id : null)}
                        title={exam.status === "archived" ? `Restore "${exam.name}"?` : `Archive "${exam.name}"?`}
                        description={
                          exam.status === "archived" ? (
                            <>The exam is marked scheduled again.</>
                          ) : (
                            <>Archived exams are hidden from active use. Every entered mark and result is kept.</>
                          )
                        }
                        successMessage={exam.status === "archived" ? "Exam restored." : "Exam archived."}
                        onConfirm={() => setExamStatus(exam.id, exam.status === "archived" ? "scheduled" : "archived")}
                        onSuccess={() => router.refresh()}
                      />
                    )}
                    {canManage && !exam.hasResults && (
                      <ConfirmButton
                        label="Delete"
                        variant="dangerSolid"
                        open={deleteRowId === exam.id}
                        onOpenChange={(open) => setDeleteRowId(open ? exam.id : null)}
                        title={`Delete "${exam.name}" permanently?`}
                        description={<>This cannot be undone. It is possible only because no student results exist yet.</>}
                        successMessage="Exam deleted."
                        onConfirm={() => deleteExam(exam.id)}
                        onSuccess={() => router.refresh()}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}

      {canManage && (
        <DesignDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          title="Create exam"
          description="An exam belongs to one course in the batch. Only students taking that course get marks."
        >
          {createOpen && (
            <CreateExamFields
              batches={batches.filter((batch) => batch.status !== "archived" && batch.status !== "completed")}
              onCancel={() => setCreateOpen(false)}
              onSaved={() => {
                setCreateOpen(false);
                router.refresh();
              }}
            />
          )}
        </DesignDialog>
      )}
    </section>
  );
}

const guardedCreateExam = guardAction(createExam);
const initialState: ExamFormState = { ok: false };

const RULES: DesignFormRule[] = [
  { name: "batchId", label: "Batch", required: true, kind: "select" },
  { name: "courseId", label: "Course", required: true, kind: "select" },
  { name: "name", label: "Name", required: true },
  {
    name: "maxMarks",
    label: "Maximum marks",
    required: true,
    check: (value) => (Number(value) > 0 ? null : "Enter the maximum marks, for example 100."),
  },
];

function CreateExamFields({
  batches,
  onCancel,
  onSaved,
}: {
  batches: ExamBatchOption[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [state, formAction, pending] = useActionState(guardedCreateExam, initialState);
  const { formRef, errors, banner, validate, blur, showServerError } = useDesignForm(RULES);
  const [batchId, setBatchId] = useState(batches.length === 1 ? batches[0].id : "");
  const batch = batches.find((b) => b.id === batchId) ?? null;
  const [courseId, setCourseId] = useState(batch && batch.courses.length === 1 ? batch.courses[0].id : "");

  useEffect(() => {
    if (state.ok) {
      showSuccessToast("Exam created.");
      onSaved();
    } else if (state.error) {
      showServerError(state.error.message, [
        [/course/i, "courseId"],
        [/batch/i, "batchId"],
        [/max/i, "maxMarks"],
        [/name/i, "name"],
      ]);
    }
    // Re-run only for a new action result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form
      ref={formRef}
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={onDesignSubmit(validate, (data) => startTransition(() => formAction(data)))}
    >
      <DialogBody>
        <FieldGrid fill>
          <DField label="Batch" name="batchId" required error={errors.batchId}>
            <select
              name="batchId"
              value={batchId}
              onChange={(event) => {
                const next = batches.find((b) => b.id === event.target.value);
                setBatchId(event.target.value);
                setCourseId(next && next.courses.length === 1 ? next.courses[0].id : "");
              }}
              onBlur={blur("batchId")}
              className={controlClass(Boolean(errors.batchId))}
              {...invalidProps("batchId", errors.batchId)}
            >
              <option value="">{batches.length === 0 ? "No planned or active batch" : "Choose a batch"}</option>
              {batches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} · {b.name}
                </option>
              ))}
            </select>
          </DField>
          <DField label="Course" name="courseId" required error={errors.courseId}>
            <select
              name="courseId"
              value={courseId}
              disabled={!batch}
              onChange={(event) => setCourseId(event.target.value)}
              onBlur={blur("courseId")}
              className={controlClass(Boolean(errors.courseId))}
              {...invalidProps("courseId", errors.courseId)}
            >
              <option value="">{batch ? "Choose the course" : "Choose a batch first"}</option>
              {batch?.courses.map((course) => (
                <option key={course.id} value={course.id}>
                  {course.name}
                </option>
              ))}
            </select>
          </DField>
          <DField label="Name" name="name" required error={errors.name} full>
            <input
              type="text"
              name="name"
              maxLength={200}
              placeholder="Final exam"
              onBlur={blur("name")}
              className={controlClass(Boolean(errors.name))}
              {...invalidProps("name", errors.name)}
            />
          </DField>
          <DField label="Maximum marks" name="maxMarks" required error={errors.maxMarks}>
            <input
              type="number"
              name="maxMarks"
              min={1}
              step="any"
              inputMode="decimal"
              defaultValue="100"
              onBlur={blur("maxMarks")}
              className={controlClass(Boolean(errors.maxMarks))}
              {...invalidProps("maxMarks", errors.maxMarks)}
            />
          </DField>
          <DField label="Date (optional)" name="examDate">
            <input type="date" name="examDate" className={controlClass(false)} />
          </DField>
        </FieldGrid>
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter onCancel={onCancel} submitLabel="Create" pendingLabel="Creating…" pending={pending} disabled={batches.length === 0} />
    </form>
  );
}
