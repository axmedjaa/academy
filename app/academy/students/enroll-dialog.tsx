"use client";

import { startTransition, useActionState, useEffect, useMemo, useState } from "react";
import { enrollExistingStudent, type EnrollExistingStudentFormState } from "@/lib/academies/register-student-actions";
import type { EnrollBatchOption } from "@/lib/academies/enroll-options";
import type { ProgramBatchOption } from "@/lib/academies/program-enrollments";
import { guardAction } from "@/lib/ui/guard-action";
import { showInfoToast, showSuccessToast } from "@/lib/ui/toast";
import { DField, DesignDialog, DialogBody, DialogFooter, FormErrorBanner, controlClass, onDesignSubmit, useDesignForm } from "@/app/academy/_shell/design-form";
import { NO_COURSE_YET, RegistrationEnrollmentFields, RegistrationSummary, type RegistrationEnrollmentValue } from "./registration-enrollment";

/**
 * Enroll an existing student — the ONE enrollment workflow used everywhere
 * (student page, Students list, Admissions, Batch detail), with the same
 * choices as registration: individual courses (each with its own batch,
 * fee, discount, plan, amount paid now and payment method) or a complete
 * program (one program fee in monthly installments, optional first
 * payment). The first press shows the summary; the second confirms. Every
 * entry point posts to the same server action (`enrollExistingStudent`),
 * which re-checks permission, tenant, branch scope, duplicates and money.
 *
 * - `student` fixes the student; otherwise a student picker is shown.
 * - `lockedBatchId` (Batch detail) offers only that batch.
 */

const guardedEnroll = guardAction(enrollExistingStudent);
const initialState: EnrollExistingStudentFormState = { ok: false };

export interface EnrollStudentOption {
  id: string;
  fullName: string;
  studentNumber: string;
}

interface CommonProps {
  enrollBatches: EnrollBatchOption[];
  programBatches: ProgramBatchOption[];
  canRecordPayments: boolean;
  /** Active "batchId:courseId" pairs per student id (not offered again). */
  enrolledPairs?: Record<string, string[]>;
  /** Programs the fixed student is actively enrolled in. */
  takenProgramIds?: string[];
}

function EnrollFields({
  student,
  students,
  studentsNote,
  enrollBatches,
  programBatches,
  canRecordPayments,
  enrolledPairs = {},
  takenProgramIds = [],
  onCancel,
  onSaved,
}: CommonProps & {
  student: EnrollStudentOption | null;
  students: EnrollStudentOption[];
  studentsNote?: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [state, formAction, pending] = useActionState(guardedEnroll, initialState);
  const { formRef, banner, setBanner } = useDesignForm([]);
  const [studentId, setStudentId] = useState(student?.id ?? "");
  const [query, setQuery] = useState("");
  const [enrollment, setEnrollment] = useState<RegistrationEnrollmentValue>(NO_COURSE_YET);
  const [reviewing, setReviewing] = useState(false);

  const takenCourseIds = useMemo(() => (enrolledPairs[studentId] ?? []).map((pair) => pair.split(":")[1]), [enrolledPairs, studentId]);
  const needle = query.trim().toLowerCase();
  const visibleStudents = needle ? students.filter((s) => `${s.fullName} ${s.studentNumber}`.toLowerCase().includes(needle)) : students;

  useEffect(() => {
    if (state.ok) {
      if (state.warning) showInfoToast(state.warning);
      else showSuccessToast(enrollment.mode === "program" ? "Enrolled in the program." : "Student enrolled.");
      onSaved();
    } else if (state.error) {
      setBanner(state.error.message);
    }
    // Re-run only for a new action result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form
      ref={formRef}
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={onDesignSubmit(
        () => {
          if (!studentId) {
            setBanner("Choose the student to enroll.");
            return false;
          }
          if (enrollment.problem) {
            setBanner(enrollment.problem);
            return false;
          }
          if (!reviewing) {
            setReviewing(true);
            setBanner(null);
            window.setTimeout(() => document.getElementById("enroll-summary")?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 0);
            return false;
          }
          return true;
        },
        (data) => startTransition(() => formAction(data)),
      )}
    >
      <input type="hidden" name="studentId" value={studentId} />
      <input type="hidden" name="enrollment" value={enrollment.payload ? JSON.stringify(enrollment.payload) : ""} />
      <DialogBody>
        {!student && (
          <div className="mb-4">
            <DField label="Student" name="studentPicker" required hint={studentsNote}>
              {students.length > 8 && (
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search by name or student number"
                  aria-label="Search students"
                  className={`${controlClass(false)} mb-2`}
                />
              )}
              <select
                value={studentId}
                onChange={(event) => {
                  setStudentId(event.target.value);
                  setEnrollment(NO_COURSE_YET);
                  setReviewing(false);
                }}
                className={controlClass(false)}
              >
                <option value="">{students.length === 0 ? "No student to enroll" : visibleStudents.length === 0 ? "No student matches" : "Choose a student"}</option>
                {visibleStudents.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.fullName} ({s.studentNumber})
                  </option>
                ))}
              </select>
            </DField>
          </div>
        )}
        {studentId ? (
          <RegistrationEnrollmentFields
            key={studentId}
            enrollBatches={enrollBatches}
            programBatches={programBatches}
            canRecordPayments={canRecordPayments}
            allowNone={false}
            takenCourseIds={takenCourseIds}
            takenProgramIds={student ? takenProgramIds : []}
            onChange={(value) => {
              setEnrollment(value);
              setReviewing(false);
            }}
          />
        ) : (
          <p className="text-sm text-muted">Choose a student to see the courses and programs they can join.</p>
        )}
        {reviewing && (
          <div id="enroll-summary" className="mt-4">
            <RegistrationSummary value={enrollment} canRecordPayments={canRecordPayments} />
            <p className="mt-2 text-xs text-muted">Check the details, then press Confirm enrollment.</p>
          </div>
        )}
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter
        onCancel={onCancel}
        submitLabel={reviewing ? "Confirm enrollment" : "Review and confirm"}
        pendingLabel="Enrolling…"
        pending={pending}
        disabled={enrollBatches.length === 0 && programBatches.length === 0}
      />
    </form>
  );
}

export function EnrollStudentDialog({
  open,
  onOpenChange,
  student = null,
  students = [],
  studentsNote,
  lockedBatchId,
  title,
  enrollBatches,
  programBatches,
  onEnrolled,
  ...rest
}: CommonProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fixed student (student page, Admissions row). Omit to pick one. */
  student?: EnrollStudentOption | null;
  students?: EnrollStudentOption[];
  studentsNote?: string;
  /** Batch detail: only this batch is offered. */
  lockedBatchId?: string;
  title?: string;
  onEnrolled?: () => void;
}) {
  const courseBatches = lockedBatchId ? enrollBatches.filter((b) => b.id === lockedBatchId) : enrollBatches;
  const programOptions = lockedBatchId ? programBatches.filter((b) => b.batchId === lockedBatchId) : programBatches;
  return (
    <DesignDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title ?? (student ? `Enroll ${student.fullName}` : "Enroll a student")}
      description="Individual courses each get their own batch, fee and payment. A complete program has one program fee paid in monthly installments."
    >
      {open && (
        <EnrollFields
          student={student}
          students={students}
          studentsNote={studentsNote}
          enrollBatches={courseBatches}
          programBatches={programOptions}
          {...rest}
          onCancel={() => onOpenChange(false)}
          onSaved={() => {
            onOpenChange(false);
            onEnrolled?.();
          }}
        />
      )}
    </DesignDialog>
  );
}
