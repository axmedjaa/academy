"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  cancelCertificateAction,
  issueCertificateAction,
  verifyCertificateInternalAction,
} from "@/lib/academies/certificates-actions";
import { NETWORK_ERROR_MESSAGE } from "@/lib/ui/guard-action";
import { formatDate } from "@/lib/ui/date";
import { showSuccessToast } from "@/lib/ui/toast";
import { Button } from "@/app/academy/_shell/ui";
import { Icon } from "@/app/academy/_shell/icons";
import { ROW_BTN } from "@/app/academy/_shell/page-blocks";
import { StudentPicker, type StudentPickerOption } from "@/app/academy/_shell/student-picker";
import { ActionDialog, DField, ReasonField, controlClass, invalidProps } from "@/app/academy/_shell/design-form";

/**
 * Certificates client pieces (design A17): the staff verify card (the same
 * lookup and fields as the public page), Issue certificate, and Cancel.
 * All three are the existing server actions, which check access, academy
 * scope, eligibility and state.
 */

type VerifyState =
  | { kind: "idle" }
  | { kind: "valid" | "cancelled"; code: string; studentName: string; programName: string; courseName: string; issuedAt: Date }
  | { kind: "missing"; code: string }
  | { kind: "error"; message: string };

export function VerifyCertificateCard() {
  const [code, setCode] = useState("");
  const [state, setState] = useState<VerifyState>({ kind: "idle" });
  const [pending, startTransition] = useTransition();

  function verify() {
    const value = code.trim();
    if (!value) {
      setState({ kind: "error", message: "Enter the code printed on the certificate." });
      return;
    }
    startTransition(async () => {
      try {
        const result = await verifyCertificateInternalAction(value);
        if (result.ok) {
          setState({ kind: result.certificate.status === "valid" ? "valid" : "cancelled", code: value, ...result.certificate });
        } else if (result.error.code === "not_found") {
          setState({ kind: "missing", code: value });
        } else {
          setState({ kind: "error", message: result.error.message });
        }
      } catch {
        setState({ kind: "error", message: NETWORK_ERROR_MESSAGE });
      }
    });
  }

  return (
    <section className="mb-8 rounded-card border border-border bg-surface p-5 shadow-card sm:p-6" aria-labelledby="verify-title">
      <div className="flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-tint text-brand">
          <Icon name="workspace_premium" />
        </span>
        <div className="min-w-0">
          <h2 id="verify-title" className="text-[17px] font-bold text-ink">
            Verify a certificate
          </h2>
          <p className="mt-1 text-[13px] text-muted">
            Enter the code printed on a certificate to check it. This is what the public verification page shows.
          </p>
        </div>
      </div>
      <form
        className="mt-4 flex flex-wrap gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          verify();
        }}
      >
        <label className="min-w-0 flex-[1_1_260px]">
          <span className="sr-only">Certificate code</span>
          <input
            type="text"
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            placeholder="AB3D-7HKL-9MNP-Q2ST"
            autoComplete="off"
            spellCheck={false}
            className={`${controlClass(state.kind === "error")} font-mono tracking-wide`}
            aria-invalid={state.kind === "error" || undefined}
            aria-describedby={state.kind === "error" ? "verify-error" : undefined}
          />
        </label>
        <Button type="submit" disabled={pending} className="h-11 min-w-[110px]">
          {pending ? "Checking…" : "Verify"}
        </Button>
        {state.kind !== "idle" && (
          <Button
            type="button"
            variant="secondary"
            className="h-11"
            onClick={() => {
              setCode("");
              setState({ kind: "idle" });
            }}
          >
            Clear
          </Button>
        )}
      </form>

      <div aria-live="polite">
        {state.kind === "error" && (
          <p id="verify-error" role="alert" className="mt-3 text-[13px] font-medium text-[#B91C1C]">
            {state.message}
          </p>
        )}
        {state.kind === "missing" && (
          <div className="mt-4 rounded-xl border border-border bg-app px-4 py-3 text-sm text-ink">
            <p className="font-semibold">No certificate found</p>
            <p className="mt-0.5 text-muted">No certificate uses the code {state.code}. Check the code and try again.</p>
          </div>
        )}
        {(state.kind === "valid" || state.kind === "cancelled") && (
          <div
            className={`mt-4 rounded-xl border px-4 py-3 ${
              state.kind === "valid" ? "border-[#BBF7D0] bg-[#F0FDF4]" : "border-[#FECACA] bg-[#FEF2F2]"
            }`}
          >
            <p className={`flex items-center gap-2 font-semibold ${state.kind === "valid" ? "text-[#166534]" : "text-[#991B1B]"}`}>
              <Icon name={state.kind === "valid" ? "check_circle" : "cancel"} width={18} height={18} />
              {state.kind === "valid" ? "Valid certificate" : "This certificate was cancelled"}
            </p>
            <dl className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted">Student</dt>
                <dd className="font-semibold text-ink">{state.studentName}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Course</dt>
                <dd className="font-semibold text-ink">{state.courseName}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Program</dt>
                <dd className="font-semibold text-ink">{state.programName}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Issued</dt>
                <dd className="font-semibold text-ink">{formatDate(state.issuedAt)}</dd>
              </div>
            </dl>
            <Link href={`/verify/${encodeURIComponent(state.code)}`} target="_blank" className="mt-3 inline-flex text-[13px] font-semibold !text-brand">
              Open the public verification page
            </Link>
          </div>
        )}
      </div>
    </section>
  );
}

export interface CertificateBatchOption {
  id: string;
  label: string;
  /** The batch's courses; a certificate is issued for one of them. */
  courses: { id: string; name: string }[];
}

export function IssueCertificateButton({
  studentOptions,
  batchOptions,
}: {
  studentOptions: StudentPickerOption[];
  batchOptions: CertificateBatchOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [studentId, setStudentId] = useState("");
  const [batchId, setBatchId] = useState("");
  const [courseId, setCourseId] = useState("");
  const batchCourses = batchOptions.find((batch) => batch.id === batchId)?.courses ?? [];
  const reset = () => {
    setStudentId("");
    setBatchId("");
    setCourseId("");
  };
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-2">
        <Icon name="workspace_premium" width={18} height={18} />
        Issue certificate
      </Button>
      <ActionDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
        title="Issue certificate"
        description="One certificate per completed course. It needs a published, passing result in that course."
        submitLabel="Issue"
        pendingLabel="Issuing…"
        rules={[
          { name: "studentId", label: "Student", required: true, kind: "select" },
          { name: "batchId", label: "Batch", required: true, kind: "select" },
          { name: "courseId", label: "Course", required: true, kind: "select" },
        ]}
        run={async (data) => {
          try {
            const result = await issueCertificateAction(
              String(data.get("studentId")),
              String(data.get("batchId")),
              String(data.get("courseId")),
            );
            return result.ok ? null : result.error.message;
          } catch {
            return NETWORK_ERROR_MESSAGE;
          }
        }}
        onDone={() => {
          showSuccessToast("Certificate issued.");
          setOpen(false);
          reset();
          router.refresh();
        }}
      >
        {({ errors, blur }) => (
          <>
            <DField label="Student" name="studentId" required error={errors.studentId} full>
              <StudentPicker name="studentId" options={studentOptions} value={studentId} onChange={setStudentId} required />
            </DField>
            <DField label="Batch" name="batchId" required error={errors.batchId} full>
              <select
                name="batchId"
                value={batchId}
                onChange={(event) => {
                  const next = event.target.value;
                  setBatchId(next);
                  // A batch with one course needs no choice.
                  const courses = batchOptions.find((batch) => batch.id === next)?.courses ?? [];
                  setCourseId(courses.length === 1 ? courses[0].id : "");
                }}
                onBlur={blur("batchId")}
                className={controlClass(Boolean(errors.batchId))}
                {...invalidProps("batchId", errors.batchId)}
              >
                <option value="">{batchOptions.length ? "Choose the batch" : "No batches yet"}</option>
                {batchOptions.map((batch) => (
                  <option key={batch.id} value={batch.id}>
                    {batch.label}
                  </option>
                ))}
              </select>
            </DField>
            <DField
              label="Course"
              name="courseId"
              required
              error={errors.courseId}
              full
              hint={batchCourses.length > 1 ? "This batch runs several courses. Each completed course gets its own certificate." : undefined}
            >
              <select
                name="courseId"
                value={courseId}
                onChange={(event) => setCourseId(event.target.value)}
                onBlur={blur("courseId")}
                disabled={!batchId}
                className={controlClass(Boolean(errors.courseId))}
                {...invalidProps("courseId", errors.courseId)}
              >
                <option value="">{batchId ? "Choose the course" : "Choose the batch first"}</option>
                {batchCourses.map((course) => (
                  <option key={course.id} value={course.id}>
                    {course.name}
                  </option>
                ))}
              </select>
            </DField>
          </>
        )}
      </ActionDialog>
    </>
  );
}

export function CancelCertificateButton({ certificateId, code, studentName }: { certificateId: string; code: string; studentName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={ROW_BTN} onClick={() => setOpen(true)}>
        Cancel
      </button>
      <ActionDialog
        open={open}
        onOpenChange={setOpen}
        title="Cancel certificate"
        description="Cancelling is permanent. It will verify as cancelled."
        summary={[
          { label: "Student", value: studentName },
          { label: "Code", value: code },
        ]}
        submitLabel="Cancel certificate"
        pendingLabel="Cancelling…"
        danger
        rules={[{ name: "reason", label: "Reason", required: true }]}
        run={async (data) => {
          try {
            const result = await cancelCertificateAction(certificateId, String(data.get("reason") ?? "").trim());
            return result.ok ? null : result.error.message;
          } catch {
            return NETWORK_ERROR_MESSAGE;
          }
        }}
        onDone={() => {
          showSuccessToast("Certificate cancelled.");
          setOpen(false);
          router.refresh();
        }}
      >
        {({ errors, blur }) => <ReasonField errors={errors} blur={blur} placeholder="Issued to the wrong batch" />}
      </ActionDialog>
    </>
  );
}
