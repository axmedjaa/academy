"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  createTimetableEntry as createTimetableEntryForActor,
  createWeeklyTimetableEntries as createWeeklyTimetableEntriesForActor,
  deleteTimetableEntry as deleteTimetableEntryForActor,
  updateTimetableEntry as updateTimetableEntryForActor,
  type CreateTimetableEntryInput,
  type CreateWeeklyTimetableInput,
  type TimetableActionError,
  type UpdateTimetableEntryInput,
} from "@/lib/academies/timetables";
import { DAYS_OF_WEEK } from "@/lib/academies/timetable-constants";

const UNAUTHENTICATED: TimetableActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export interface TimetableFormState {
  ok: boolean;
  error?: TimetableActionError;
  /** Set on a successful `createWeeklyTimetableEntry` — the actual days that
   * got created (after server-side dedup), so the UI's confirmation message
   * (approved review §11: "Weekly timetable created for Monday, Wednesday,
   * Friday.") reflects what really happened, never a hardcoded range. */
  createdDays?: string[];
}

function parseCreateFormData(formData: FormData): CreateTimetableEntryInput {
  const room = String(formData.get("room") ?? "");
  const trainerStaffProfileId = String(formData.get("trainerStaffProfileId") ?? "");
  return {
    branchId: String(formData.get("branchId") ?? ""),
    batchId: String(formData.get("batchId") ?? ""),
    dayOfWeek: String(formData.get("dayOfWeek") ?? "") as CreateTimetableEntryInput["dayOfWeek"],
    startTime: String(formData.get("startTime") ?? ""),
    endTime: String(formData.get("endTime") ?? ""),
    room: room || null,
    trainerStaffProfileId: trainerStaffProfileId || null,
  };
}

export async function createTimetableEntry(
  _prevState: TimetableFormState,
  formData: FormData,
): Promise<TimetableFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await createTimetableEntryForActor(context, parseCreateFormData(formData));
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath(`/academy/timetable`);
  revalidatePath(`/academy/batches/${result.entry.batchId}`);
  return { ok: true };
}

/** `formData.getAll` — a checkbox group all sharing `name="daysOfWeek"`
 * gives one entry per checked box; an unchecked box contributes nothing, so
 * no explicit "unchecked" value ever needs filtering out here. */
function parseWeeklyCreateFormData(formData: FormData): CreateWeeklyTimetableInput {
  const room = String(formData.get("room") ?? "");
  const trainerStaffProfileId = String(formData.get("trainerStaffProfileId") ?? "");
  const daysOfWeek = formData.getAll("daysOfWeek").map((value) => String(value));
  return {
    branchId: String(formData.get("branchId") ?? ""),
    batchId: String(formData.get("batchId") ?? ""),
    daysOfWeek: daysOfWeek as CreateWeeklyTimetableInput["daysOfWeek"],
    startTime: String(formData.get("startTime") ?? ""),
    endTime: String(formData.get("endTime") ?? ""),
    room: room || null,
    trainerStaffProfileId: trainerStaffProfileId || null,
  };
}

/** The primary create action the UI now uses (approved review §B/§C) —
 * `createTimetableEntry` above is kept for backward compatibility and is no
 * longer called by the create form, but remains a fully working single-day
 * entry point (used directly by tests, and safe for any future caller that
 * only ever needs one day). */
export async function createWeeklyTimetableEntry(
  _prevState: TimetableFormState,
  formData: FormData,
): Promise<TimetableFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await createWeeklyTimetableEntriesForActor(context, parseWeeklyCreateFormData(formData));
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath(`/academy/timetable`);
  if (result.entries[0]) revalidatePath(`/academy/batches/${result.entries[0].batchId}`);
  // Sorted by the shared Saturday-first DAYS_OF_WEEK order (never trusting
  // FormData/DOM submission order to already match it) so the confirmation
  // message always reads "... for Saturday, Monday, Wednesday." in the same
  // order as the grid/print view, regardless of the order checkboxes were
  // checked or submitted in.
  const createdDaySet = new Set(result.entries.map((entry) => entry.dayOfWeek));
  const createdDays = DAYS_OF_WEEK.filter((day) => createdDaySet.has(day));
  return { ok: true, createdDays };
}

export async function updateTimetableEntry(
  entryId: string,
  input: UpdateTimetableEntryInput,
): Promise<{ ok: true } | { ok: false; error: TimetableActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await updateTimetableEntryForActor(context, entryId, input);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath(`/academy/timetable`);
  revalidatePath(`/academy/batches/${result.entry.batchId}`);
  return { ok: true };
}

export async function deleteTimetableEntry(
  entryId: string,
  batchId: string,
): Promise<{ ok: true } | { ok: false; error: TimetableActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await deleteTimetableEntryForActor(context, entryId);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath(`/academy/timetable`);
  revalidatePath(`/academy/batches/${batchId}`);
  return { ok: true };
}
