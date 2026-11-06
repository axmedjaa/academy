import { createHash, randomBytes } from "node:crypto";
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
import { sendEmail } from "@/lib/email/client";
import { staffInvitationEmail } from "@/lib/email/templates";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rate-limit";
import { checkAllowance } from "@/lib/subscriptions/usage";
import type { StaffActionError } from "@/lib/academies/staff";

/**
 * Staff invitations — the fix for SEC-H-01 (SECURITY_AUDIT_PRE_DEPLOYMENT.md).
 *
 * Before: "Add staff" with an email that already had an account attached that
 * account to the inviting academy at once — no password, no consent — and,
 * because the console serves one academy per account, locked the person out
 * of their own academy ("You belong to more than one academy"). The response
 * also told the inviter whether the email had an account anywhere.
 *
 * Now:
 *  1. `issueStaffInvitation` (called by `createStaff`) stores an invitation
 *     bound to one lower-cased email, this academy, the role and the branch
 *     scope the inviter is allowed to grant, and emails a one-time link. It
 *     never creates or changes an account, and never asks whether the email
 *     has one: its only email lookup is "already staff of THIS academy",
 *     which runs identically for every email. Its work and its response are
 *     the same whether or not the email has an account.
 *  2. The person opens the link (proving they control the email).
 *     - If an account exists for that email, they must be signed in AS that
 *       account and press Accept (`acceptStaffInvitation`).
 *     - If none exists, they choose their own password
 *       (`acceptStaffInvitationWithNewAccount`); nobody else ever knows it.
 *  3. Acceptance, in one transaction with the invitation row locked:
 *     re-checks status, expiry, the email match, that the account does not
 *     already work at another academy, that the inviter still holds the
 *     authority to grant this role and scope, the staff allowance and the
 *     branches; then creates the membership, profile and branch assignments
 *     and marks the invitation used. Audited on create, accept, revoke and
 *     resend. The raw token is never stored or logged — only its SHA-256.
 */

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Invitation emails one staff member may trigger per hour (create + resend). */
const INVITE_RATE_LIMIT = { maxAttempts: 30, windowSeconds: 3600 };

export type StaffInvitationStatus = "pending" | "accepted" | "revoked";

export function generateInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Delivers the link. Injectable so tests can capture the token, which no
 * other path ever exposes. Returns whether the email was handed to the
 * provider. */
export type InvitationDeliverer = (input: {
  email: string;
  token: string;
  academyName: string;
  role: AcademyRole;
  expiresAt: Date;
}) => Promise<boolean>;

export const deliverInvitationByEmail: InvitationDeliverer = async ({ email, token, academyName, role, expiresAt }) => {
  // Test runs inject their own deliverer; never email fixture addresses.
  if (env.NODE_ENV === "test") return false;
  if (!env.APP_URL) {
    logger.error("staff invitation email not sent: APP_URL is not configured");
    return false;
  }
  const acceptUrl = `${env.APP_URL.replace(/\/$/, "")}/staff-invitation?token=${encodeURIComponent(token)}`;
  const content = staffInvitationEmail({
    academyName,
    roleLabel: ACADEMY_ROLE_LABELS[role],
    acceptUrl,
    expiresOn: expiresAt.toISOString().slice(0, 10),
  });
  const result = await sendEmail({ to: email, subject: content.subject, html: content.html, text: content.text });
  // Never log the token or the link.
  if (!result.ok) logger.error("staff invitation email failed to send");
  return result.ok;
};

class InvitationRefused extends Error {
  constructor(public readonly error: StaffActionError) {
    super(error.message);
  }
}

const refuse = (code: StaffActionError["code"], message: string): never => {
  throw new InvitationRefused({ code, message });
};

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

export interface IssueStaffInvitationInput {
  actorContext: AuthContext;
  academyId: string;
  actorRole: AcademyRole;
  actorAcademyWide: boolean;
  email: string;
  role: AcademyRole;
  fullName: string;
  phone: string;
  employeeNumber?: string;
  hireDate?: string;
  grantAllBranches: boolean;
  workplace: "all" | "specific" | undefined;
  chosenBranchIds: string[];
  deliver?: InvitationDeliverer;
}

export type IssueStaffInvitationResult =
  | { ok: true; invitationId: string; email: string; role: AcademyRole; emailSent: boolean }
  | { ok: false; error: StaffActionError };

/** The branches the invitation will grant, authorized against the inviter. */
async function resolveInvitationBranches(
  tx: DbClient,
  input: Pick<IssueStaffInvitationInput, "academyId" | "actorContext" | "actorAcademyWide" | "grantAllBranches" | "workplace" | "chosenBranchIds">,
): Promise<string[]> {
  const { academyId } = input;
  if (input.grantAllBranches) {
    // All-branch access is only for Main Branch staff.
    const [main] = await tx
      .select({ id: branches.id })
      .from(branches)
      .where(and(eq(branches.academyId, academyId), eq(branches.isMain, true)))
      .limit(1);
    if (!main) refuse("validation", "This academy has no Main Branch yet. Add a branch first.");
    return [main!.id];
  }
  if (input.workplace === "specific") {
    const found = await tx
      .select({ id: branches.id })
      .from(branches)
      .where(and(eq(branches.academyId, academyId), eq(branches.status, "active"), inArray(branches.id, input.chosenBranchIds)));
    if (found.length !== input.chosenBranchIds.length) {
      refuse("validation", "One of the chosen branches is not available. Refresh and try again.");
    }
    if (!input.actorAcademyWide) {
      const own = new Set(await getAssignedBranchIds(tx, academyId, input.actorContext.userId));
      if (!input.chosenBranchIds.every((id) => own.has(id))) {
        refuse("forbidden", "You can only add staff to the branches you work in.");
      }
    }
    return input.chosenBranchIds;
  }
  // Earlier default: staff added by someone without all-branch access start
  // in that person's own branches.
  return input.actorAcademyWide ? [] : getAssignedBranchIds(tx, academyId, input.actorContext.userId);
}

/**
 * Records the invitation and emails the link. The inviter's permission,
 * role and branch checks have already run in `createStaff`.
 *
 * Enumeration: nothing here reads `users`. The one lookup that depends on
 * the email asks only whether that email is ALREADY STAFF OF THIS ACADEMY —
 * information the inviter can already see in their own staff list — and it
 * runs identically for every email.
 */
export async function issueStaffInvitation(input: IssueStaffInvitationInput): Promise<IssueStaffInvitationResult> {
  const { academyId, actorContext, email } = input;

  const limit = await checkRateLimit(`staff-invite:${actorContext.userId}`, INVITE_RATE_LIMIT);
  if (!limit.allowed) {
    return { ok: false, error: { code: "conflict", message: "Too many invitations sent. Try again later." } };
  }

  const token = generateInvitationToken();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

  let invitationId: string;
  let academyName: string;
  try {
    ({ invitationId, academyName } = await db.transaction(async (tx) => {
      const allowance = await checkAllowance(academyId, "staff", tx);
      if (!allowance.ok) refuse("allowance_exceeded", "Staff allowance could not be verified for this academy.");
      if (allowance.ok && !allowance.result.allowed) {
        refuse(
          "allowance_exceeded",
          `Staff allowance limit reached (${allowance.result.current}/${allowance.result.limit ?? 0}). Archive an existing staff member or upgrade your plan.`,
        );
      }

      // Already staff here? (own-academy information only)
      const [alreadyHere] = await tx
        .select({ id: staffProfiles.id })
        .from(staffProfiles)
        .innerJoin(users, eq(users.id, staffProfiles.userId))
        .where(and(eq(staffProfiles.academyId, academyId), eq(users.email, email)))
        .limit(1);
      if (alreadyHere) refuse("already_staff", "This person is already a staff member of this academy.");

      const [open] = await tx
        .select({ id: staffInvitations.id, expiresAt: staffInvitations.expiresAt })
        .from(staffInvitations)
        .where(and(eq(staffInvitations.academyId, academyId), eq(staffInvitations.email, email), eq(staffInvitations.status, "pending")))
        .for("update")
        .limit(1);
      if (open) {
        if (open.expiresAt.getTime() > Date.now()) {
          refuse("conflict", "An invitation to this email is already waiting to be accepted. Resend or cancel it from the invitations list.");
        }
        // An expired invitation is closed so a new one can be sent.
        await tx
          .update(staffInvitations)
          .set({ status: "revoked", revokedAt: new Date(), revokedBy: actorContext.userId, updatedAt: new Date() })
          .where(eq(staffInvitations.id, open.id));
        await recordAudit(
          {
            actorUserId: actorContext.userId,
            actorRole: input.actorRole,
            academyId,
            action: "revokeStaffInvitation",
            entityType: "staff_invitation",
            entityId: open.id,
            context: { reason: "expired; replaced by a new invitation" },
          },
          tx,
        );
      }

      const branchIds = await resolveInvitationBranches(tx, input);

      const [row] = await tx
        .insert(staffInvitations)
        .values({
          academyId,
          email,
          tokenHash: hashInvitationToken(token),
          role: input.role,
          academyWide: input.grantAllBranches,
          branchIds,
          fullName: input.fullName,
          phone: input.phone,
          employeeNumber: input.employeeNumber,
          hireDate: input.hireDate,
          invitedBy: actorContext.userId,
          expiresAt,
        })
        .returning({ id: staffInvitations.id });

      await recordAudit(
        {
          actorUserId: actorContext.userId,
          actorRole: input.actorRole,
          academyId,
          action: "createStaffInvitation",
          entityType: "staff_invitation",
          entityId: row.id,
          after: {
            email,
            role: input.role,
            fullName: input.fullName,
            branchIds,
            allBranchAccess: input.grantAllBranches,
            expiresAt: expiresAt.toISOString(),
          },
        },
        tx,
      );

      const [academy] = await tx.select({ name: academies.name }).from(academies).where(eq(academies.id, academyId)).limit(1);
      return { invitationId: row.id, academyName: academy?.name ?? "" };
    }));
  } catch (err) {
    if (err instanceof InvitationRefused) return { ok: false, error: err.error };
    if (isUniqueViolation(err)) {
      return { ok: false, error: { code: "conflict", message: "An invitation to this email is already waiting to be accepted." } };
    }
    throw err;
  }

  const deliver = input.deliver ?? deliverInvitationByEmail;
  const emailSent = await deliver({ email, token, academyName, role: input.role, expiresAt });
  return { ok: true, invitationId, email, role: input.role, emailSent };
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

/** Sends a fresh link: the old token stops working and the expiry restarts. */
export async function resendStaffInvitation(
  actorContext: AuthContext,
  invitationId: string,
  options: { deliver?: InvitationDeliverer } = {},
): Promise<{ ok: true; emailSent: boolean } | { ok: false; error: StaffActionError }> {
  const resolved = await resolveInvitationManager(actorContext);
  if (!resolved.ok) return resolved;
  const { manager } = resolved;

  const limit = await checkRateLimit(`staff-invite:${actorContext.userId}`, INVITE_RATE_LIMIT);
  if (!limit.allowed) return { ok: false, error: { code: "conflict", message: "Too many invitations sent. Try again later." } };

  const token = generateInvitationToken();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  let sent: { email: string; role: AcademyRole; academyName: string };
  try {
    sent = await db.transaction(async (tx) => {
      const invitation = await lockManagedInvitation(tx, manager, invitationId);
      await tx
        .update(staffInvitations)
        .set({ tokenHash: hashInvitationToken(token), expiresAt, updatedAt: new Date() })
        .where(eq(staffInvitations.id, invitation.id));
      await recordAudit(
        {
          actorUserId: actorContext.userId,
          actorRole: manager.role,
          academyId: manager.academyId,
          action: "resendStaffInvitation",
          entityType: "staff_invitation",
          entityId: invitation.id,
          before: { expiresAt: invitation.expiresAt.toISOString() },
          after: { expiresAt: expiresAt.toISOString() },
        },
        tx,
      );
      const [academy] = await tx.select({ name: academies.name }).from(academies).where(eq(academies.id, manager.academyId)).limit(1);
      return { email: invitation.email, role: invitation.role, academyName: academy?.name ?? "" };
    });
  } catch (err) {
    if (err instanceof InvitationRefused) return { ok: false, error: err.error };
    throw err;
  }

  const deliver = options.deliver ?? deliverInvitationByEmail;
  const emailSent = await deliver({ email: sent.email, token, academyName: sent.academyName, role: sent.role, expiresAt });
  return { ok: true, emailSent };
}
