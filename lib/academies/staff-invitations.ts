import { createHash } from "node:crypto";
import { and, asc, eq, gt, inArray, ne, notExists } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import {
  academies,
  academyMemberships,
  branches,
  staffBranchAssignments,
  staffInvitations,
  staffProfiles,
  users,
} from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { getAssignedBranchIds } from "@/lib/academies/branch-access";
import { rolesAssignableBy } from "@/lib/academies/staff-role-rules";
import { ACADEMY_STAFF_ACTION, getAcademyPermissionLevel } from "@/lib/auth/academy-permissions";
import { hashPassword, passwordSchema } from "@/lib/auth/password";
import { ACADEMY_ROLE_LABELS } from "@/lib/auth/role-labels";
import { isRetiredAcademyRole, type AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import { recordAudit } from "@/lib/audit";
import { checkAllowance } from "@/lib/subscriptions/usage";
import type { StaffActionError } from "@/lib/academies/staff";

/**
 * LEGACY staff invitations (SEC-H-01, migration 0045).
 *
 * Staff accounts are now created directly by an administrator with a
 * temporary password (lib/academies/staff.ts createStaff); no new
 * invitations are issued or re-sent, and no invitation email is sent.
 *
 * What remains serves invitations sent before that change, so none of them
 * breaks: until it expires (at most 7 days after it was last sent) or is
 * cancelled, a pending invitation can still be accepted exactly as before.
 *  - If an account exists for the invited email, the person must be signed
 *    in AS that account and press Accept (`acceptStaffInvitation`).
 *  - If none exists, they choose their own password
 *    (`acceptStaffInvitationWithNewAccount`).
 * Acceptance, in one transaction with the invitation row locked, re-checks
 * status, expiry, the email match, that the account does not already work
 * at another academy, that the inviter still holds the authority to grant
 * this role and scope, the staff allowance and the branches; then creates
 * the membership, profile and branch assignments and marks the invitation
 * used. Staff managers can still list and cancel pending invitations.
 * The raw token is never stored or logged — only its SHA-256.
 *
 * Once no pending invitation is left anywhere, this module, /staff-invitation
 * and the pending-invitations list can be removed.
 */

export type StaffInvitationStatus = "pending" | "accepted" | "revoked";

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

class InvitationRefused extends Error {
  constructor(public readonly error: StaffActionError) {
    super(error.message);
  }
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

// ---------------------------------------------------------------------------
// Accept
// ---------------------------------------------------------------------------

/** One message for every unusable link: unknown, expired, used or cancelled. */
const INVALID_INVITATION: StaffActionError = {
  code: "not_found",
  message: "This invitation link is invalid or has expired. Ask the academy to send a new invitation.",
};

const WRONG_ACCOUNT: StaffActionError = {
  code: "forbidden",
  message: "This invitation was sent to a different email address. Sign in with the account it was sent to.",
};

type InvitationRow = typeof staffInvitations.$inferSelect;

async function lockUsableInvitation(tx: DbClient, token: string): Promise<InvitationRow> {
  const [invitation] = await tx
    .select()
    .from(staffInvitations)
    .where(eq(staffInvitations.tokenHash, hashInvitationToken(token)))
    .for("update")
    .limit(1);
  if (!invitation || invitation.status !== "pending" || invitation.expiresAt.getTime() <= Date.now()) {
    throw new InvitationRefused(INVALID_INVITATION);
  }
  return invitation;
}

/**
 * Creates the membership, staff profile and branch assignments for an
 * invitation, inside the caller's transaction (invitation row locked).
 */
async function provisionFromInvitation(tx: DbClient, invitation: InvitationRow, userId: string): Promise<{ staffProfileId: string }> {
  const { academyId } = invitation;

  const [academy] = await tx.select({ closedAt: academies.closedAt }).from(academies).where(eq(academies.id, academyId)).limit(1);
  if (!academy || academy.closedAt) throw new InvitationRefused(INVALID_INVITATION);

  // The inviter must still hold the authority this invitation grants:
  // active, not archived, allowed to give this role (and all-branch access).
  const [inviter] = await tx
    .select({ role: academyMemberships.role, academyWide: academyMemberships.academyWide })
    .from(academyMemberships)
    .where(
      and(
        eq(academyMemberships.academyId, academyId),
        eq(academyMemberships.userId, invitation.invitedBy),
        eq(academyMemberships.status, "active"),
        notExists(
          tx
            .select({ id: staffProfiles.id })
            .from(staffProfiles)
            .where(and(eq(staffProfiles.academyId, academyId), eq(staffProfiles.userId, invitation.invitedBy), eq(staffProfiles.status, "archived"))),
        ),
      ),
    )
    .limit(1);
  const inviterMayGrant =
    inviter &&
    !isRetiredAcademyRole(invitation.role) &&
    ["full", "manage"].includes(getAcademyPermissionLevel(inviter.role, ACADEMY_STAFF_ACTION)) &&
    rolesAssignableBy(inviter.role, "create").includes(invitation.role) &&
    (!invitation.academyWide || inviter.role === "academy_owner");
  if (!inviterMayGrant) throw new InvitationRefused(INVALID_INVITATION);

  // Lockout guard: the console serves one academy per account. Joining a
  // second academy would block the person from the one they already use.
  const [elsewhere] = await tx
    .select({ id: academyMemberships.id })
    .from(academyMemberships)
    .where(
      and(
        eq(academyMemberships.userId, userId),
        eq(academyMemberships.status, "active"),
        ne(academyMemberships.academyId, academyId),
        notExists(
          tx
            .select({ id: staffProfiles.id })
            .from(staffProfiles)
            .where(
              and(
                eq(staffProfiles.userId, academyMemberships.userId),
                eq(staffProfiles.academyId, academyMemberships.academyId),
                eq(staffProfiles.status, "archived"),
              ),
            ),
        ),
      ),
    )
    .limit(1);
  if (elsewhere) {
    throw new InvitationRefused({
      code: "conflict",
      message:
        "Your account already works at another academy, and one account can only be used for one academy. Ask the academy to invite a different email address.",
    });
  }

  const [existingProfile] = await tx
    .select({ id: staffProfiles.id })
    .from(staffProfiles)
    .where(and(eq(staffProfiles.academyId, academyId), eq(staffProfiles.userId, userId)))
    .limit(1);
  if (existingProfile) throw new InvitationRefused({ code: "already_staff", message: "You are already a staff member of this academy." });

  const [existingMembership] = await tx
    .select({ id: academyMemberships.id, status: academyMemberships.status })
    .from(academyMemberships)
    .where(and(eq(academyMemberships.academyId, academyId), eq(academyMemberships.userId, userId)))
    .limit(1);
  if (existingMembership?.status === "active") {
    throw new InvitationRefused({ code: "already_staff", message: "You are already a staff member of this academy." });
  }

  const allowance = await checkAllowance(academyId, "staff", tx);
  if (!allowance.ok || !allowance.result.allowed) {
    throw new InvitationRefused({ code: "allowance_exceeded", message: "This academy has reached its staff limit. Ask the academy to contact Dardar." });
  }

  // The branches must still exist and be active in this academy.
  if (invitation.branchIds.length > 0) {
    const found = await tx
      .select({ id: branches.id })
      .from(branches)
      .where(and(eq(branches.academyId, academyId), eq(branches.status, "active"), inArray(branches.id, invitation.branchIds)));
    if (found.length !== new Set(invitation.branchIds).size) {
      throw new InvitationRefused({ code: "conflict", message: "This invitation is out of date. Ask the academy to send a new one." });
    }
  }

  if (existingMembership) {
    // A removed earlier membership is reactivated with exactly the invited
    // role and scope; nothing from the earlier employment carries over.
    await tx
      .update(academyMemberships)
      .set({ role: invitation.role, status: "active", academyWide: invitation.academyWide })
      .where(eq(academyMemberships.id, existingMembership.id));
  } else {
    await tx.insert(academyMemberships).values({
      userId,
      academyId,
      role: invitation.role,
      status: "active",
      academyWide: invitation.academyWide,
    });
  }

  const [profile] = await tx
    .insert(staffProfiles)
    .values({
      academyId,
      userId,
      employeeNumber: invitation.employeeNumber,
      fullName: invitation.fullName,
      phone: invitation.phone,
      email: invitation.email,
      hireDate: invitation.hireDate,
    })
    .returning();

  if (invitation.branchIds.length > 0) {
    await tx
      .insert(staffBranchAssignments)
      .values(invitation.branchIds.map((branchId) => ({ academyId, staffProfileId: profile.id, branchId })));
  }

  await tx
    .update(staffInvitations)
    .set({ status: "accepted", acceptedAt: new Date(), acceptedUserId: userId, updatedAt: new Date() })
    .where(eq(staffInvitations.id, invitation.id));

  // The staff record is attributed to the inviter, as before; the
  // acceptance to the person who accepted.
  await recordAudit(
    {
      actorUserId: invitation.invitedBy,
      actorRole: inviter!.role,
      academyId,
      action: "createStaff",
      entityType: "staff_profile",
      entityId: profile.id,
      after: {
        id: profile.id,
        userId,
        fullName: profile.fullName,
        phone: profile.phone,
        email: invitation.email,
        employeeNumber: profile.employeeNumber,
        hireDate: profile.hireDate,
        status: profile.status,
        role: invitation.role,
        branchIds: invitation.branchIds,
        allBranchAccess: invitation.academyWide,
      },
      context: { viaInvitation: invitation.id },
    },
    tx,
  );
  await recordAudit(
    {
      actorUserId: userId,
      actorRole: invitation.role,
      academyId,
      action: "acceptStaffInvitation",
      entityType: "staff_invitation",
      entityId: invitation.id,
      before: { status: "pending" },
      after: { status: "accepted", staffProfileId: profile.id, role: invitation.role, branchIds: invitation.branchIds, allBranchAccess: invitation.academyWide },
    },
    tx,
  );

  return { staffProfileId: profile.id };
}

export type AcceptStaffInvitationResult =
  | { ok: true; academyId: string; staffProfileId: string; userId: string; role: AcademyRole }
  | { ok: false; error: StaffActionError };

function mapAcceptError(err: unknown): { ok: false; error: StaffActionError } {
  if (err instanceof InvitationRefused) return { ok: false, error: err.error };
  // A concurrent acceptance that slipped past the row lock still meets the
  // (user_id, academy_id) unique indexes.
  if (isUniqueViolation(err)) return { ok: false, error: { code: "already_staff", message: "You are already a staff member of this academy." } };
  throw err;
}

/** Existing account: the caller must be signed in as the invited email. */
export async function acceptStaffInvitation(actorContext: AuthContext, token: string): Promise<AcceptStaffInvitationResult> {
  if (!token) return { ok: false, error: INVALID_INVITATION };
  const [user] = await db
    .select({ id: users.id, email: users.email, status: users.status })
    .from(users)
    .where(eq(users.id, actorContext.userId))
    .limit(1);
  if (!user || user.status !== "active") return { ok: false, error: { code: "forbidden", message: "You must be signed in." } };

  try {
    return await db.transaction(async (tx) => {
      const invitation = await lockUsableInvitation(tx, token);
      if (invitation.email !== user.email.toLowerCase()) throw new InvitationRefused(WRONG_ACCOUNT);
      const { staffProfileId } = await provisionFromInvitation(tx, invitation, user.id);
      return { ok: true as const, academyId: invitation.academyId, staffProfileId, userId: user.id, role: invitation.role };
    });
  } catch (err) {
    return mapAcceptError(err);
  }
}

const newAccountSchema = z.object({ token: z.string().min(1), password: passwordSchema });

/**
 * No account exists for the invited email: the person sets their own
 * password. The emailed token is the proof they control the address.
 */
export async function acceptStaffInvitationWithNewAccount(token: string, password: string): Promise<AcceptStaffInvitationResult> {
  const parsed = newAccountSchema.safeParse({ token, password });
  if (!parsed.success) {
    const passwordIssue = parsed.error.issues.find((issue) => issue.path[0] === "password");
    return passwordIssue
      ? { ok: false, error: { code: "validation", message: passwordIssue.message } }
      : { ok: false, error: INVALID_INVITATION };
  }
  const passwordHash = await hashPassword(parsed.data.password);

  try {
    return await db.transaction(async (tx) => {
      const invitation = await lockUsableInvitation(tx, parsed.data.token);
      const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.email, invitation.email)).limit(1);
      if (existing) {
        throw new InvitationRefused({ code: "conflict", message: "An account already exists for this email. Sign in to accept the invitation." });
      }
      const [user] = await tx.insert(users).values({ email: invitation.email, passwordHash }).returning({ id: users.id });
      const { staffProfileId } = await provisionFromInvitation(tx, invitation, user.id);
      return { ok: true as const, academyId: invitation.academyId, staffProfileId, userId: user.id, role: invitation.role };
    });
  } catch (err) {
    return mapAcceptError(err);
  }
}

export type StaffInvitationView =
  | { valid: false }
  | {
      valid: true;
      academyName: string;
      roleLabel: string;
      email: string;
      /** How the holder of this link completes it. */
      mode: "create_account" | "sign_in" | "accept" | "wrong_account";
    };

/**
 * What the acceptance page shows. Only the holder of the emailed link (the
 * email's owner) learns whether that email already has an account.
 */
export async function describeStaffInvitation(token: string, viewer: AuthContext | null): Promise<StaffInvitationView> {
  if (!token) return { valid: false };
  const [row] = await db
    .select({ invitation: staffInvitations, academyName: academies.name, closedAt: academies.closedAt })
    .from(staffInvitations)
    .innerJoin(academies, eq(academies.id, staffInvitations.academyId))
    .where(and(eq(staffInvitations.tokenHash, hashInvitationToken(token)), eq(staffInvitations.status, "pending"), gt(staffInvitations.expiresAt, new Date())))
    .limit(1);
  if (!row || row.closedAt) return { valid: false };
  const { invitation } = row;

  const [account] = await db.select({ id: users.id }).from(users).where(eq(users.email, invitation.email)).limit(1);
  let mode: "create_account" | "sign_in" | "accept" | "wrong_account";
  if (!account) mode = "create_account";
  else if (!viewer) mode = "sign_in";
  else mode = viewer.userId === account.id ? "accept" : "wrong_account";

  return { valid: true, academyName: row.academyName, roleLabel: ACADEMY_ROLE_LABELS[invitation.role], email: invitation.email, mode };
}

// ---------------------------------------------------------------------------
// Manage (list, revoke, resend)
// ---------------------------------------------------------------------------

interface InvitationManager {
  academyId: string;
  role: AcademyRole;
  academyWide: boolean;
  ownBranchIds: Set<string>;
}

async function resolveInvitationManager(actorContext: AuthContext): Promise<{ ok: true; manager: InvitationManager } | { ok: false; error: StaffActionError }> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") return { ok: false, error: { code: "blocked", message: access.message } };
  const level = getAcademyPermissionLevel(access.membershipRole, ACADEMY_STAFF_ACTION);
  if (level !== "full" && level !== "manage") {
    return { ok: false, error: { code: "forbidden", message: "You don't have permission to manage this academy's staff." } };
  }
  const own = access.academyWide ? [] : await getAssignedBranchIds(db, access.academyId, actorContext.userId);
  return { ok: true, manager: { academyId: access.academyId, role: access.membershipRole, academyWide: access.academyWide, ownBranchIds: new Set(own) } };
}

/** May this person see, cancel or resend this invitation? The same reach
 * they would need to have created it. */
function canManageInvitation(manager: InvitationManager, invitation: Pick<InvitationRow, "role" | "academyWide" | "branchIds">): boolean {
  if (!rolesAssignableBy(manager.role, "create").includes(invitation.role)) return false;
  if (invitation.academyWide && manager.role !== "academy_owner") return false;
  if (manager.academyWide) return true;
  return invitation.branchIds.length > 0 && invitation.branchIds.every((id) => manager.ownBranchIds.has(id));
}

export interface StaffInvitationRecord {
  id: string;
  email: string;
  fullName: string;
  role: AcademyRole;
  allBranchAccess: boolean;
  branchIds: string[];
  createdAt: Date;
  expiresAt: Date;
  expired: boolean;
}

export type ListStaffInvitationsResult = { ok: true; invitations: StaffInvitationRecord[] } | { ok: false; error: StaffActionError };

/** Pending (including expired, not yet replaced) invitations this person may manage. */
export async function listStaffInvitations(actorContext: AuthContext): Promise<ListStaffInvitationsResult> {
  const resolved = await resolveInvitationManager(actorContext);
  if (!resolved.ok) return resolved;
  const { manager } = resolved;
  const rows = await db
    .select()
    .from(staffInvitations)
    .where(and(eq(staffInvitations.academyId, manager.academyId), eq(staffInvitations.status, "pending")))
    .orderBy(asc(staffInvitations.createdAt));
  const now = Date.now();
  return {
    ok: true,
    invitations: rows
      .filter((row) => canManageInvitation(manager, row))
      .map((row) => ({
        id: row.id,
        email: row.email,
        fullName: row.fullName,
        role: row.role,
        allBranchAccess: row.academyWide,
        branchIds: row.branchIds,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        expired: row.expiresAt.getTime() <= now,
      })),
  };
}

const NOT_FOUND: StaffActionError = { code: "not_found", message: "Invitation not found." };

async function lockManagedInvitation(tx: DbClient, manager: InvitationManager, invitationId: string): Promise<InvitationRow> {
  if (!z.string().uuid().safeParse(invitationId).success) throw new InvitationRefused(NOT_FOUND);
  const [invitation] = await tx
    .select()
    .from(staffInvitations)
    .where(and(eq(staffInvitations.id, invitationId), eq(staffInvitations.academyId, manager.academyId)))
    .for("update")
    .limit(1);
  if (!invitation || invitation.status !== "pending") throw new InvitationRefused(NOT_FOUND);
  if (!canManageInvitation(manager, invitation)) {
    throw new InvitationRefused({ code: "forbidden", message: "You can't manage this invitation." });
  }
  return invitation;
}

export async function revokeStaffInvitation(actorContext: AuthContext, invitationId: string): Promise<{ ok: true } | { ok: false; error: StaffActionError }> {
  const resolved = await resolveInvitationManager(actorContext);
  if (!resolved.ok) return resolved;
  const { manager } = resolved;
  try {
    await db.transaction(async (tx) => {
      const invitation = await lockManagedInvitation(tx, manager, invitationId);
      await tx
        .update(staffInvitations)
        .set({ status: "revoked", revokedAt: new Date(), revokedBy: actorContext.userId, updatedAt: new Date() })
        .where(eq(staffInvitations.id, invitation.id));
      await recordAudit(
        {
          actorUserId: actorContext.userId,
          actorRole: manager.role,
          academyId: manager.academyId,
          action: "revokeStaffInvitation",
          entityType: "staff_invitation",
          entityId: invitation.id,
          before: { status: "pending", email: invitation.email, role: invitation.role },
          after: { status: "revoked" },
        },
        tx,
      );
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof InvitationRefused) return { ok: false, error: err.error };
    throw err;
  }
}
