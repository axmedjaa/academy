"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  registerStudent as registerStudentForActor,
  type RegisterStudentActionError,
  type RegisterStudentInput,
} from "@/lib/academies/register-student";
import {
  requestNewStudentPhotoUploadUrl as requestNewStudentPhotoUploadUrlForActor,
  type RequestStudentPhotoUploadUrlInput,
  type RequestStudentPhotoUploadUrlResult,
  type StudentActionError,
} from "@/lib/academies/students";
import { enrollStudentInBatch } from "@/lib/academies/batch-assignments";
import { recordEnrollmentPayment } from "@/lib/academies/fee-periods";
import { enrollStudentInProgram } from "@/lib/academies/program-enrollments";
import { issueReceipt } from "@/lib/academies/student-payments";
import { FEE_INTERVAL_MONTHS_OPTIONS } from "@/lib/db/schema";
import { dollarsToCents } from "@/lib/ui/money";

const UNAUTHENTICATED: RegisterStudentActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

// Same message, but typed for students.ts's own StudentActionError union
// (distinct from this file's RegisterStudentActionError) — the photo
// upload-url action below delegates to students.ts, not register-student.ts.
const PHOTO_UNAUTHENTICATED: StudentActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export interface RegisterStudentFormState {
  ok: boolean;
  error?: RegisterStudentActionError;
  /** Set only when the student WAS created but a later enrollment or payment
   * step failed — the registration itself still succeeded, so this is a
   * warning, not `error`. Each failed step is named, and can be redone from
   * the student's page. */
  enrollmentWarning?: string;
  /** Set whenever `ok` is true — the newly-created student's id, so the
   * client can redirect to its detail page (`/academy/students/[id]`).
   * Never set on failure. */
  studentId?: string;
}

/**
 * FormData -> RegisterStudentInput. Shape translation only — every field
 * is re-validated by lib/academies/register-student.ts's Zod schema right
 * after this runs, same convention as
 * lib/academies/staff-actions.ts's parseCreateStaffFormData.
 */
function parseRegisterStudentFormData(formData: FormData): RegisterStudentInput {
  return {
    branchId: String(formData.get("branchId") ?? ""),
    fullName: String(formData.get("fullName") ?? ""),
    dateOfBirth: String(formData.get("dateOfBirth") ?? ""),
    gender: String(formData.get("gender") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    email: String(formData.get("email") ?? ""),
    guardianName: String(formData.get("guardianName") ?? ""),
    guardianPhone: String(formData.get("guardianPhone") ?? ""),
    address: String(formData.get("address") ?? ""),
    district: String(formData.get("district") ?? ""),
    profileImageRef: String(formData.get("profileImageRef") ?? ""),
  };
}

/* ------------------------------------------------------------------ */
/* The enrollment chosen on the registration form                      */
/* ------------------------------------------------------------------ */

const cents = (label: string) => z.number().int(`${label} must be a whole number of cents.`).nonnegative(`${label} can't be negative.`);
const installments = z.union(
  FEE_INTERVAL_MONTHS_OPTIONS.map((value) => z.literal(value)) as [z.ZodLiteral<number>, ...z.ZodLiteral<number>[]],
  { message: "Choose a payment plan." },
);
const method = z.enum(["cash", "mobile_money", "bank_transfer"]);

/** One money line (a course or the program): fee, discount, plan, and what
 * was paid now. Final fee = fee − discount; outstanding = final − paid. */
const moneyLine = {
  feeCents: z.number().int().positive("Enter the fee."),
  discountCents: cents("Discount"),
  installments,
  paidCents: cents("Amount paid"),
  method: method.optional(),
};
function checkMoney(line: { feeCents: number; discountCents: number; paidCents: number; method?: string }, ctx: z.RefinementCtx, what: string) {
  if (line.discountCents >= line.feeCents) {
    ctx.addIssue({ code: "custom", message: `${what}: the discount must be less than the fee.` });
  } else if (line.paidCents > line.feeCents - line.discountCents) {
    ctx.addIssue({ code: "custom", message: `${what}: the amount paid is more than the fee after discount.` });
  }
  if (line.paidCents > 0 && !line.method) {
    ctx.addIssue({ code: "custom", message: `${what}: choose how the payment was made.` });
  }
}

const registrationEnrollmentSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("none") }),
    z.object({
      type: z.literal("courses"),
      lines: z
        .array(z.object({ courseId: z.string().uuid("Select a course"), courseName: z.string().max(300), batchId: z.string().uuid("Select a batch"), ...moneyLine }))
        .min(1, "Add at least one course.")
        .max(20),
    }),
    z.object({ type: z.literal("program"), batchId: z.string().uuid("Select a program batch"), programName: z.string().max(300), ...moneyLine }),
  ])
  .superRefine((data, ctx) => {
    if (data.type === "courses") {
      const seen = new Set<string>();
      for (const line of data.lines) {
        if (seen.has(line.courseId)) ctx.addIssue({ code: "custom", message: `${line.courseName} was added twice.` });
        seen.add(line.courseId);
        checkMoney(line, ctx, line.courseName);
      }
    } else if (data.type === "program") {
      checkMoney(data, ctx, data.programName);
    }
  });

export type RegistrationEnrollment = z.input<typeof registrationEnrollmentSchema>;

/** Step 1 of the upload flow for a brand-new student's photo (this form
 * has no studentId yet) — see students.ts's requestNewStudentPhotoUploadUrl. */
export async function requestNewStudentPhotoUploadUrlAction(
  input: RequestStudentPhotoUploadUrlInput,
): Promise<RequestStudentPhotoUploadUrlResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: PHOTO_UNAUTHENTICATED };
  }
  return requestNewStudentPhotoUploadUrlForActor(context, input);
}

/**
 * Register student, then (optionally) enroll them — form-bound via
 * useActionState by the Register student dialog.
 *
 * The enrollment arrives as one JSON field (`enrollment`) and is validated in
 * full BEFORE the student is created, so a bad fee/discount/payment never
 * leaves a half-registered student. Then, reusing the existing, separately
 * tested actions (no new money logic here):
 *
 * - Individual courses: each course line becomes its OWN enrollment in its
 *   own batch (`enrollStudentInBatch`, one course each), with its own fee
 *   (after discount), its own installments and — when money was paid now —
 *   its own payment with its own method (`recordEnrollmentPayment`) and its
 *   own receipt. One course's payment never touches another's.
 * - Complete program: one program enrollment (`enrollStudentInProgram`) — the
 *   program fee once, in monthly installments, with the first payment in the
 *   same transaction — and its receipt. The included courses get no fees.
 *
 * Every action re-checks permission, tenant and branch scope itself. If a
 * step after the student was created fails, the student is kept and the
 * failure is reported as a warning naming the step.
 */
export async function registerStudent(
  _prevState: RegisterStudentFormState,
  formData: FormData,
): Promise<RegisterStudentFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  // Validate the enrollment first (a JSON field; absent = legacy single-batch
  // fields below, or no enrollment).
  const rawEnrollment = String(formData.get("enrollment") ?? "").trim();
  let enrollment: z.output<typeof registrationEnrollmentSchema> = { type: "none" };
  if (rawEnrollment) {
    let json: unknown;
    try {
      json = JSON.parse(rawEnrollment);
    } catch {
      return { ok: false, error: { code: "validation", message: "The enrollment details couldn't be read. Please try again." } };
    }
    const parsed = registrationEnrollmentSchema.safeParse(json);
    if (!parsed.success) {
      return { ok: false, error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Check the enrollment details." } };
    }
    enrollment = parsed.data;
  }

  const result = await registerStudentForActor(context, parseRegisterStudentFormData(formData));
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  const studentId = result.student.id;

  revalidatePath("/academy/students");
  revalidatePath("/academy/admissions");

  const warnings = await applyEnrollment(context, studentId, enrollment);
  if (enrollment.type === "none") {
    // Legacy single-batch fields (one batch, its courses, one plan) — kept so
    // an older form still works exactly as before.
    const batchId = String(formData.get("batchId") ?? "").trim();
    if (batchId) {
      const currency = String(formData.get("paymentPlanCurrency") ?? "").trim();
      const anchorDate = String(formData.get("paymentPlanAnchorDate") ?? "").trim();
      const enrollResult = await enrollStudentInBatch(context, {
        batchId,
        studentId,
        courseIds: formData.getAll("courseIds").map(String).filter(Boolean),
        paymentPlan: {
          intervalMonths: Number(formData.get("paymentPlanIntervalMonths") ?? 0),
          amountCents: dollarsToCents(String(formData.get("paymentPlanAmountDollars") ?? "")) ?? NaN,
          currency: currency.length > 0 ? currency : undefined,
          anchorDate: anchorDate.length > 0 ? anchorDate : undefined,
        },
      });
      if (!enrollResult.ok) warnings.push(`could not be enrolled in the selected courses: ${enrollResult.error.message}`);
    }
  }

  if (warnings.length > 0) {
    revalidatePath(`/academy/students/${studentId}`);
    return { ok: true, enrollmentWarning: `Student registered, but: ${warnings.join("; ")}.`, studentId };
  }
  return { ok: true, studentId };
}

export interface EnrollExistingStudentFormState {
  ok: boolean;
  error?: { code: string; message: string };
  /** Some (not all) steps failed; each is named. */
  warning?: string;
}

/**
 * Enroll an EXISTING student (the student page's Enroll dialog) with the same
 * choices as registration: individual courses — each with its own batch, fee,
 * discount, plan, payment and method — or a complete program with one program
 * fee in monthly installments. Same validation and the same tested actions as
 * `registerStudent`; every action re-checks permission, tenant and branch
 * scope, so a foreign or unknown student id is refused there.
 */
export async function enrollExistingStudent(
  _prevState: EnrollExistingStudentFormState,
  formData: FormData,
): Promise<EnrollExistingStudentFormState> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };

  const studentId = String(formData.get("studentId") ?? "").trim();
  if (!z.string().uuid().safeParse(studentId).success) {
    return { ok: false, error: { code: "validation", message: "Student not found." } };
  }
  let json: unknown;
  try {
    json = JSON.parse(String(formData.get("enrollment") ?? ""));
  } catch {
    return { ok: false, error: { code: "validation", message: "Choose the courses or the program to enroll in." } };
  }
  const parsed = registrationEnrollmentSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Check the enrollment details." } };
  }
  if (parsed.data.type === "none") {
    return { ok: false, error: { code: "validation", message: "Choose the courses or the program to enroll in." } };
  }

  const steps = parsed.data.type === "courses" ? parsed.data.lines.length : 1;
  const warnings = await applyEnrollment(context, studentId, parsed.data);
  revalidatePath(`/academy/students/${studentId}`);
  revalidatePath("/academy/students");
  // Nothing was enrolled at all: a plain error (the form stays open).
  const notEnrolled = warnings.filter((warning) => warning.includes(": not enrolled ("));
  if (notEnrolled.length === steps) {
    return { ok: false, error: { code: "validation", message: warnings.join("; ") } };
  }
  if (warnings.length > 0) return { ok: true, warning: `Enrolled, but: ${warnings.join("; ")}.` };
  return { ok: true };
}

/**
 * Carries out a validated enrollment for a student who already exists, using
 * only the existing, separately tested actions (no new money logic). Returns
 * one warning per failed step; an empty list means everything was done.
 */
async function applyEnrollment(
  context: NonNullable<Awaited<ReturnType<typeof getAuthContext>>>,
  studentId: string,
  enrollment: z.output<typeof registrationEnrollmentSchema>,
): Promise<string[]> {
  const warnings: string[] = [];

  if (enrollment.type === "courses") {
    for (const line of enrollment.lines) {
      const enrolled = await enrollStudentInBatch(context, {
        batchId: line.batchId,
        studentId,
        courseIds: [line.courseId],
        paymentPlan: {
          intervalMonths: line.installments,
          amountCents: line.feeCents - line.discountCents,
          discountCents: line.discountCents,
        },
      });
      if (!enrolled.ok) {
        warnings.push(`${line.courseName}: not enrolled (${enrolled.error.message})`);
        continue;
      }
      if (line.paidCents > 0 && line.method) {
        const paid = await recordEnrollmentPayment(context, {
          studentId,
          enrollmentId: enrolled.enrollment.id,
          amountCents: line.paidCents,
          method: line.method,
          receivedAt: new Date().toISOString(),
          idempotencyKey: randomUUID(),
        });
        if (!paid.ok) {
          warnings.push(`${line.courseName}: enrolled, but the payment wasn't recorded (${paid.error.message})`);
          continue;
        }
        const receipt = await issueReceipt(context, paid.payment.id);
        if (!receipt.ok) warnings.push(`${line.courseName}: payment recorded, but its receipt wasn't issued (${receipt.error.message})`);
      }
    }
  } else if (enrollment.type === "program") {
    const enrolled = await enrollStudentInProgram(context, {
      studentId,
      batchId: enrollment.batchId,
      programFeeCents: enrollment.feeCents,
      discountCents: enrollment.discountCents,
      installments: enrollment.installments,
      initialPayment:
        enrollment.paidCents > 0 && enrollment.method
          ? { amountCents: enrollment.paidCents, method: enrollment.method, receivedAt: new Date().toISOString() }
          : undefined,
      idempotencyKey: randomUUID(),
    });
    if (!enrolled.ok) {
      warnings.push(`${enrollment.programName}: not enrolled (${enrolled.error.message})`);
    } else if (enrolled.initialPaymentId) {
      const receipt = await issueReceipt(context, enrolled.initialPaymentId);
      if (!receipt.ok) warnings.push(`${enrollment.programName}: payment recorded, but its receipt wasn't issued (${receipt.error.message})`);
    }
  }
  return warnings;
}
