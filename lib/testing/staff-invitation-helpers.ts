import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";
import { createStaff, type CreateStaffInput, type StaffActionError } from "@/lib/academies/staff";
import {
  acceptStaffInvitation,
  acceptStaffInvitationWithNewAccount,
  type InvitationDeliverer,
} from "@/lib/academies/staff-invitations";

/**
 * Test-only: the invitation token never leaves the server except in the
 * email. Tests read it through an injected deliverer instead.
 */
export function captureInvitations() {
  const sent: { email: string; token: string; academyName: string; role: AcademyRole; expiresAt: Date }[] = [];
  const deliver: InvitationDeliverer = async (input) => {
    sent.push(input);
    return true;
  };
  return { deliver, sent, lastToken: () => sent[sent.length - 1]?.token ?? "" };
}

export const TEST_INVITEE_PASSWORD = "supersecurepassword123";

export type InviteAndAcceptResult =
  | { ok: true; staffProfileId: string; userId: string; role: AcademyRole; invitationId: string }
  | { ok: false; error: StaffActionError; stage: "invite" | "accept" };

/**
 * The full secure path that replaced "createStaff creates staff at once":
 * invite, then accept as the invited person — signed in as the existing
 * account if there is one, otherwise by creating the account with their own
 * password.
 */
export async function inviteAndAccept(actorContext: AuthContext, input: CreateStaffInput): Promise<InviteAndAcceptResult> {
  const mail = captureInvitations();
  const invited = await createStaff(actorContext, input, { deliver: mail.deliver });
  if (!invited.ok) return { ok: false, error: invited.error, stage: "invite" };

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, invited.email)).limit(1);
  const accepted = existing
    ? await acceptStaffInvitation({ userId: existing.id, branchIds: [], academyWide: false }, mail.lastToken())
    : await acceptStaffInvitationWithNewAccount(mail.lastToken(), TEST_INVITEE_PASSWORD);
  if (!accepted.ok) return { ok: false, error: accepted.error, stage: "accept" };
  return { ok: true, staffProfileId: accepted.staffProfileId, userId: accepted.userId, role: accepted.role, invitationId: invited.invitationId };
}
