"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  assignStaffBranches as assignStaffBranchesForActor,
  listAssignedBranches as listAssignedBranchesForActor,
  setAllBranchAccess as setAllBranchAccessForActor,
  setStaffWorkplace as setStaffWorkplaceForActor,
  type SetAllBranchAccessResult,
  type SetStaffWorkplaceResult,
  type StaffWorkplaceInput,
  type StaffBranchActionError,
} from "@/lib/academies/staff-branch-assignments";

const UNAUTHENTICATED: StaffBranchActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

/**
 * PLAN.md §4 server action name. Same "called directly from a client
 * component, not through useActionState" convention as
 * lib/academies/staff-actions.ts's updateStaff/assignStaffRole — this is a
 * per-staff-member control (a multi-select of branches), not a full page
 * form.
 */
export async function assignStaffBranches(
  staffProfileId: string,
  branchIds: string[],
): Promise<{ ok: true; branchIds: string[] } | { ok: false; error: StaffBranchActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await assignStaffBranchesForActor(context, staffProfileId, branchIds);
  if (result.ok) {
    revalidatePath("/academy/staff");
    revalidatePath("/academy/branches", "layout");
  }
  return result;
}

/** Read counterpart, e.g. to prefill an edit-branches control. */
export async function getAssignedBranches(
  staffProfileId: string,
): Promise<{ ok: true; branchIds: string[] } | { ok: false; error: StaffBranchActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  return listAssignedBranchesForActor(context, staffProfileId);
}

/** Owner-only: grant or revoke a staff member's access to all branches. */
export async function setAllBranchAccess(staffProfileId: string, enabled: boolean): Promise<SetAllBranchAccessResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await setAllBranchAccessForActor(context, staffProfileId, enabled);
  if (result.ok) {
    revalidatePath("/academy/staff");
    revalidatePath("/academy/branches", "layout");
  }
  return result;
}

/** "Where they work" for an existing staff member (staff list's Edit branches dialog). */
export async function setStaffWorkplace(
  staffProfileId: string,
  input: StaffWorkplaceInput,
): Promise<SetStaffWorkplaceResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await setStaffWorkplaceForActor(context, staffProfileId, input);
  if (result.ok) {
    revalidatePath("/academy/staff");
    revalidatePath("/academy/branches", "layout");
  }
  return result;
}
