import { createHash, randomBytes } from "node:crypto";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { staffInvitations } from "@/lib/db/schema";
import { createStaff, type CreateStaffInput, type CreateStaffResult } from "@/lib/academies/staff";

/** The temporary password test fixtures give directly created staff. */
export const TEST_TEMPORARY_PASSWORD = "temporary-Password-123!";

/** createStaff input with the temporary password optional (defaulted). */
export type StaffTestInput = Omit<CreateStaffInput, "temporaryPassword"> & { temporaryPassword?: string };

/** Creates a staff account directly, the way the Staff page does. */
export function createStaffAccount(actorContext: AuthContext, input: StaffTestInput): Promise<CreateStaffResult> {
  return createStaff(actorContext, { temporaryPassword: TEST_TEMPORARY_PASSWORD, ...input });
}

/**
 * Test-only: a pending invitation as the retired invitation flow used to
 * store it (no new ones are issued). Returns the raw token, which only the
 * emailed link ever carried; only its SHA-256 is stored.
 */
export async function seedLegacyInvitation(input: {
  academyId: string;
  invitedBy: string;
  email: string;
  role?: AcademyRole;
  branchIds?: string[];
  academyWide?: boolean;
  fullName?: string;
  expiresAt?: Date;
}): Promise<{ invitationId: string; token: string }> {
  const token = randomBytes(32).toString("base64url");
  const [row] = await db
    .insert(staffInvitations)
    .values({
      academyId: input.academyId,
      email: input.email.toLowerCase(),
      tokenHash: createHash("sha256").update(token).digest("hex"),
      role: input.role ?? "trainer",
      academyWide: input.academyWide ?? false,
      branchIds: input.branchIds ?? [],
      fullName: input.fullName ?? "Invited Person",
      phone: "+1-555-0123",
      invitedBy: input.invitedBy,
      expiresAt: input.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
    .returning({ id: staffInvitations.id });
  return { invitationId: row.id, token };
}
