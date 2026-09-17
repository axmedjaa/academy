"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  createTimetableEntry as createTimetableEntryForActor,
  deleteTimetableEntry as deleteTimetableEntryForActor,
  updateTimetableEntry as updateTimetableEntryForActor,
  type CreateTimetableEntryInput,
  type TimetableActionError,
  type UpdateTimetableEntryInput,
} from "@/lib/academies/timetables";

const UNAUTHENTICATED: TimetableActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export interface TimetableFormState {
  ok: boolean;
  error?: TimetableActionError;
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
