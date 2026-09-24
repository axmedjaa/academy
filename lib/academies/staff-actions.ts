"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  assignStaffRole as assignStaffRoleForActor,
  createStaff as createStaffForActor,
  deleteStaff as deleteStaffForActor,
  getStaffDeletionEligibility as getStaffDeletionEligibilityForActor,
  removeStaffMembership as removeStaffMembershipForActor,
  updateStaff as updateStaffForActor,
  type CreateStaffInput,
  type GetStaffDeletionEligibilityResult,
  type StaffActionError,
  type UpdateStaffInput,
} from "@/lib/academies/staff";
import type { AcademyRole } from "@/lib/auth/roles";

const UNAUTHENTICATED: StaffActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export interface CreateStaffFormState {
  ok: boolean;
  error?: StaffActionError;
}

/**
 * FormData -> CreateStaffInput. Shape translation only — every field is
 * re-validated by lib/academies/staff.ts's Zod schema right after this
 * runs, same convention as lib/academies/settings-actions.ts's
 * parseAcademySettingsFormData.
 */
function parseCreateStaffFormData(formData: FormData): CreateStaffInput {
  return {
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
    fullName: String(formData.get("fullName") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    employeeNumber: String(formData.get("employeeNumber") ?? ""),
    hireDate: String(formData.get("hireDate") ?? ""),
    role: String(formData.get("role") ?? "") as CreateStaffInput["role"],
  };
}

/** PLAN.md §4 server action name, form-bound via useActionState for /academy/staff/new. */
export async function createStaff(
  _prevState: CreateStaffFormState,
  formData: FormData,
): Promise<CreateStaffFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await createStaffForActor(context, parseCreateStaffFormData(formData));
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/staff");
  return { ok: true };
}

/**
 * PLAN.md §4 server action name. Called directly (not through
 * useActionState) from the staff list's inline per-row status/role
 * controls, same convention as lib/platform-staff/actions.ts's
 * grantPlatformPermission.
 */
export async function updateStaff(
  staffProfileId: string,
  input: UpdateStaffInput,
): Promise<{ ok: true } | { ok: false; error: StaffActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await updateStaffForActor(context, staffProfileId, input);
  if (result.ok) {
    revalidatePath("/academy/staff");
    return { ok: true };
  }
  return result;
}

/** PLAN.md §4 server action name. See updateStaff above. */
export async function assignStaffRole(
  targetUserId: string,
  role: AcademyRole,
): Promise<{ ok: true } | { ok: false; error: StaffActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await assignStaffRoleForActor(context, targetUserId, role);
  if (result.ok) {
    revalidatePath("/academy/staff");
    return { ok: true };
  }
  return result;
}

/**
 * New in the delete/deletion-audit pass — see
 * lib/academies/staff.ts's removeStaffMembership for the actual guard
 * (owner-only for an owner target, last-owner protection, audit-logged
 * status flip to "removed", never a hard delete).
 */
export async function removeStaffMembership(
  targetUserId: string,
): Promise<{ ok: true } | { ok: false; error: StaffActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await removeStaffMembershipForActor(context, targetUserId);
  if (result.ok) {
    revalidatePath("/academy/staff");
    return { ok: true };
  }
  return result;
}

/** Read-only preview for the staff table's Delete button. */
export async function getStaffDeletionEligibility(
  staffProfileId: string,
): Promise<GetStaffDeletionEligibilityResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }
  return getStaffDeletionEligibilityForActor(context, staffProfileId);
}

/** Plain-callable permanent-deletion action. `confirmedName` must equal
 * the staff member's exact current full name — re-checked server-side
 * here, same convention as lib/academies/delete-academy.ts's
 * deleteAcademy. */
export async function deleteStaff(
  staffProfileId: string,
  confirmedName: string,
): Promise<{ ok: true } | { ok: false; error: StaffActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await deleteStaffForActor(context, staffProfileId, confirmedName);
  if (!result.ok) {
    return result;
  }

  revalidatePath("/academy/staff");
  return { ok: true };
}
