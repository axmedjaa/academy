"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  setStaffBranchAssignment as setStaffBranchAssignmentForActor,
  type SetStaffBranchAssignmentResult,
} from "@/lib/academies/branch-overview";

/** Thin "use server" wrapper — every check (staff permission, academy,
 * branch scope) and the audit row happen in lib/academies/branch-overview.ts
 * and lib/academies/staff-branch-assignments.ts. */
export async function setStaffBranchAssignment(
  staffProfileId: string,
  branchId: string,
  assigned: boolean,
): Promise<SetStaffBranchAssignmentResult> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: { code: "forbidden", message: "You must be signed in." } };

  const result = await setStaffBranchAssignmentForActor(context, staffProfileId, branchId, assigned);
  if (result.ok) {
    revalidatePath("/academy/branches", "layout");
    revalidatePath("/academy/staff");
  }
  return result;
}
