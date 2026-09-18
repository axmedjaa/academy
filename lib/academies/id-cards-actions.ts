"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { students } from "@/lib/db/schema";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  getIdCard,
  issueStudentIdCard as issueStudentIdCardForActor,
  reprintStudentIdCard as reprintStudentIdCardForActor,
  type IdCardActionError,
  type IdCardRecord,
  type IssueStudentIdCardInput,
} from "@/lib/academies/id-cards";

const UNAUTHENTICATED: IdCardActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export interface IdCardFormState {
  ok: boolean;
  error?: IdCardActionError;
  card?: IdCardRecord | null;
  /** Echoed back so the client component knows which student the result
   * (or "no card yet") belongs to, across a form round-trip. */
  studentId?: string;
  /**
   * Display-only convenience for the visual card preview (Phase D of this
   * wave — app/academy/id-cards/id-card-visual.tsx). NOT part of
   * lib/academies/id-cards.ts's own IdCardRecord (that file is left
   * untouched); resolved here, in the thin "use server" wrapper layer, by a
   * plain by-id lookup against `students` — safe because by the time this
   * is populated, `getIdCard`/`issueStudentIdCard`/`reprintStudentIdCard`
   * has already tenant/branch-scoped and authorized this exact studentId,
   * so this is a display-field fetch on an already-authorized id, not a
   * fresh authorization decision.
   */
  studentName?: string;
}

async function resolveStudentName(studentId: string): Promise<string | undefined> {
  const [row] = await db.select({ fullName: students.fullName }).from(students).where(eq(students.id, studentId)).limit(1);
  return row?.fullName;
}

/**
 * FormData -> IssueStudentIdCardInput. Same "shape translation only, real
 * validation happens in lib/academies/id-cards.ts's Zod schema right after
 * this" convention as lib/academies/branches-actions.ts's
 * parseBranchFormData.
 */
function parseIssueFormData(formData: FormData): IssueStudentIdCardInput {
  return {
    studentId: String(formData.get("studentId") ?? ""),
    photoFileRef: String(formData.get("photoFileRef") ?? ""),
  };
}

/**
 * Not a PLAN.md-named action (issue/reprint are the two the plan names) —
 * a small read-only lookup so `/academy/id-cards` can show "does this
 * student already have a card" before deciding whether to render the
 * issue form or the reprint button. Delegates entirely to
 * lib/academies/id-cards.ts's getIdCard for the actual tenant/branch
 * scoping and permission check.
 */
export async function lookupIdCard(
  _prevState: IdCardFormState,
  formData: FormData,
): Promise<IdCardFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const studentId = String(formData.get("studentId") ?? "");
  const result = await getIdCard(context, studentId);
  if (!result.ok) {
    return { ok: false, error: result.error, studentId };
  }

  return { ok: true, card: result.card, studentId, studentName: await resolveStudentName(studentId) };
}

/** PLAN.md Item 40 server action name. */
export async function issueStudentIdCard(
  _prevState: IdCardFormState,
  formData: FormData,
): Promise<IdCardFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const input = parseIssueFormData(formData);
  const result = await issueStudentIdCardForActor(context, input);
  if (!result.ok) {
    return { ok: false, error: result.error, studentId: input.studentId };
  }

  revalidatePath("/academy/id-cards");
  return {
    ok: true,
    card: result.card,
    studentId: input.studentId,
    studentName: await resolveStudentName(input.studentId),
  };
}

/**
 * Single dispatch entry point for the client component
 * (app/academy/id-cards/id-card-lookup.tsx). `useActionState` keeps exactly
 * one state object per hook instance, updated only when *that* hook's
 * action runs — binding three separate hooks (one per action below) to one
 * shared "most recent result" display would mean whichever action's state
 * flips `ok: true` first stays "the latest" forever, since the other two
 * hooks' state objects never change again on their own. Routing all three
 * form submissions through this one action (keyed by a hidden `intent`
 * field) keeps a single `useActionState` instance, so the component always
 * shows the result of whichever form was actually just submitted.
 */
export async function runIdCardAction(
  prevState: IdCardFormState,
  formData: FormData,
): Promise<IdCardFormState> {
  const intent = String(formData.get("intent") ?? "");
  switch (intent) {
    case "lookup":
      return lookupIdCard(prevState, formData);
    case "issue":
      return issueStudentIdCard(prevState, formData);
    case "reprint":
      return reprintStudentIdCard(prevState, formData);
    default:
      return { ok: false, error: { code: "validation", message: "Unknown action." } };
  }
}

/** PLAN.md Item 40 server action name. Card id is read from the form itself
 * (a hidden field), never trusted from any other client-suppliable
 * source — same IDOR-safe posture as every other tenant-scoped action in
 * this codebase; lib/academies/id-cards.ts's reprintStudentIdCard still
 * re-checks it belongs to the caller's own academy (and, for Admissions
 * Officer, their assigned branch) regardless. */
export async function reprintStudentIdCard(
  _prevState: IdCardFormState,
  formData: FormData,
): Promise<IdCardFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const studentId = String(formData.get("studentId") ?? "");
  const cardId = String(formData.get("cardId") ?? "");
  const result = await reprintStudentIdCardForActor(context, cardId);
  if (!result.ok) {
    return { ok: false, error: result.error, studentId };
  }

  revalidatePath("/academy/id-cards");
  // F1 security fix: resolve the display name from the verified
  // `result.card.studentId` (the id `reprintStudentIdCardForActor` actually
  // authorized), never from the client-supplied `studentId` form field —
  // that field is only echoed back for UI continuity and is not checked
  // against the card's real owner, so using it here would let a caller
  // disclose an arbitrary student's name by tampering with a hidden field.
  return { ok: true, card: result.card, studentId, studentName: await resolveStudentName(result.card.studentId) };
}
