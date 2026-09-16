import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  pgEnum,
  uniqueIndex,
  index,
  jsonb,
} from "drizzle-orm/pg-core";

// Only "active"/"disabled" are used anywhere in PLAN.md (Phase 0 §6, Account &
// Membership Lifecycle: "A disabled users.status account cannot obtain a session").
export const userStatusEnum = pgEnum("user_status", ["active", "disabled"]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    status: userStatusEnum("status").notNull().default("active"),
    failedLoginAttempts: integer("failed_login_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("users_email_unique").on(table.email)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_unique").on(table.tokenHash),
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_expires_at_idx").on(table.expiresAt),
  ],
);

export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("password_reset_tokens_token_hash_unique").on(
      table.tokenHash,
    ),
  ],
);

// Platform Owner / Platform Admin — see Cross-Cutting Architecture
// Decisions: "Platform access via platform_memberships (platform_owner |
// platform_admin)". Not the same enum as academy roles (academy_memberships,
// a later phase) — platform and academy access are entirely separate.
export const platformRoleEnum = pgEnum("platform_role", [
  "platform_owner",
  "platform_admin",
]);

export const platformMemberships = pgTable(
  "platform_memberships",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: platformRoleEnum("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Not explicitly stated in PLAN.md's constraints list, but implied by
    // the identity model description ("platform access via ... (platform_owner
    // | platform_admin)" — one role, not a set) — a user has at most one
    // platform-level role.
    uniqueIndex("platform_memberships_user_id_unique").on(table.userId),
  ],
);

// capability is free-form text, not an enum: the actual grantable/ungrantable
// capability set is an application-layer concern (hasPermission(), Item 10;
// Master Permission Matrix), not a fixed list at the schema level — later
// phases introduce new capabilities without a schema change.
export const platformAdminPermissions = pgTable(
  "platform_admin_permissions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    capability: text("capability").notNull(),
  },
  (table) => [
    uniqueIndex("platform_admin_permissions_user_capability_unique").on(
      table.userId,
      table.capability,
    ),
  ],
);

export const auditResultEnum = pgEnum("audit_result", ["success", "failure"]);

/**
 * Single audit_logs table for the whole app (Cross-Cutting Architecture
 * Decisions), written exclusively through recordAudit(). academy_id and
 * branch_id now carry real FK constraints (Phase 1, Item 19 — academies/
 * branches exist as of this migration; the tables are declared further
 * down this file, but the forward reference is safe because
 * `.references()` takes a callback Drizzle only invokes after the module
 * has fully loaded). Both stay nullable: plenty of audit rows have no
 * academy/branch context at all (e.g. platform-level actions), and
 * neither FK cascades — academies/branches are never hard-deleted
 * anywhere in this plan, so an audit row can never be orphaned by a
 * delete that isn't supposed to happen in the first place.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    actorRole: text("actor_role"),
    academyId: uuid("academy_id").references(() => academies.id),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    branchId: uuid("branch_id").references(() => branches.id),
    before: jsonb("before"),
    after: jsonb("after"),
    context: jsonb("context"),
    reason: text("reason"),
    requestId: text("request_id"),
    result: auditResultEnum("result").notNull().default("success"),
    failureReason: text("failure_reason"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("audit_logs_academy_id_created_at_idx").on(
      table.academyId,
      table.createdAt,
    ),
    index("audit_logs_actor_user_id_created_at_idx").on(
      table.actorUserId,
      table.createdAt,
    ),
    index("audit_logs_request_id_idx").on(table.requestId),
  ],
);

// No unique constraint on user_id: enrollMfaForUser reuses an existing
// unverified row rather than relying on a DB constraint to prevent
// duplicates (see lib/auth/mfa.ts) — PLAN.md's column list is exactly
// id/user_id/secret_encrypted/verified_at/created_at, nothing more.
export const mfaTotpCredentials = pgTable("mfa_totp_credentials", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  secretEncrypted: text("secret_encrypted").notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const mfaRecoveryCodes = pgTable(
  "mfa_recovery_codes",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("mfa_recovery_codes_code_hash_unique").on(table.codeHash),
  ],
);

// Phase 1, Item 19. PLAN.md's exact column list (Phase 1 §2): "id, name,
// slug unique, default_currency, settings jsonb, type, address, phone,
// email, website, logo_ref, registration_number, primary_contact_name,
// primary_contact_phone, created_by, approved_by, approved_at nullable,
// closed_at nullable, created_at) — no status column." Per Decision #1
// there is deliberately no independent academies.status lifecycle: access
// is governed entirely by academy_subscriptions.status (a later item)
// plus closed_at for permanent closure.
//
// The "expanded profile" fields (type/address/phone/email/website/
// logo_ref/registration_number/primary_contact_*) are nullable text
// columns here: PLAN.md's onboarding checklist treats "profile complete"
// as a computed precondition for activateAcademy (Phase 1 §2 "Onboarding,
// end to end", step 7), which only makes sense if these fields can be
// empty before that point is reached. `type` has no fixed value set
// anywhere in PLAN.md/DESIGN.md (unlike user_status/platform_role, which
// are exhaustively enumerated), so it's free text, not a pgEnum.
// Required-ness for registration itself is a later item's concern
// (registerAcademy's Zod schema), not a NOT NULL constraint here.
// default_currency and created_by are NOT NULL: every academy needs a
// currency for financial calculations from day one, and every academy
// row is created by a specific platform_owner (Phase 1 §2's
// registerAcademy transaction).
export const academies = pgTable(
  "academies",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    defaultCurrency: text("default_currency").notNull(),
    settings: jsonb("settings"),
    type: text("type"),
    address: text("address"),
    phone: text("phone"),
    email: text("email"),
    website: text("website"),
    logoRef: text("logo_ref"),
    registrationNumber: text("registration_number"),
    primaryContactName: text("primary_contact_name"),
    primaryContactPhone: text("primary_contact_phone"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("academies_slug_unique").on(table.slug)],
);

// Branches archive instead of getting deleted (Archive & Deactivation
// Rules: "Branches ... Restorable: yes, by the same roles"), so this
// models an active/archived lifecycle — same two-value-enum convention
// established by userStatusEnum above.
export const branchStatusEnum = pgEnum("branch_status", [
  "active",
  "archived",
]);

export const branches = pgTable(
  "branches",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    academyId: uuid("academy_id")
      .notNull()
      .references(() => academies.id),
    name: text("name").notNull(),
    code: text("code").notNull(),
    status: branchStatusEnum("status").notNull().default("active"),
    address: text("address"),
    phone: text("phone"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Database Constraints & Indexes: "branches: (academy_id, code) unique."
    uniqueIndex("branches_academy_id_code_unique").on(
      table.academyId,
      table.code,
    ),
    // Database Constraints & Indexes: "branches(academy_id)".
    index("branches_academy_id_idx").on(table.academyId),
  ],
);

// Matches lib/auth/roles.ts's ACADEMY_ROLES exactly. PLAN.md/DESIGN.md
// only ever name these six roles as display labels (Master Permission
// Matrix, DESIGN.md role tables) — never as snake_case identifiers — so
// this pgEnum is the authoritative point (as lib/auth/roles.ts itself
// says) that fixes the values; update that file's comment to point here
// rather than re-deriving the slugs if it's ever touched again.
export const academyRoleEnum = pgEnum("academy_role", [
  "academy_owner",
  "academy_admin",
  "manager",
  "admissions_officer",
  "finance_officer",
  "trainer",
]);

// Account & Membership Lifecycle: "Removing an academy membership revokes
// that user's active sessions for that academy context" — removal is
// described as an action with side effects on an existing row, not a
// hard delete, consistent with the project-wide no-hard-delete
// convention (Planning Gaps Resolution §12/§6). Modeled as an
// active/removed status rather than reusing "archived" (that word is
// reserved in PLAN.md for the Archive & Deactivation Rules table's
// entities — branches/staff/students/courses — which academy_memberships
// is not one of).
export const membershipStatusEnum = pgEnum("membership_status", [
  "active",
  "removed",
]);

export const academyMemberships = pgTable(
  "academy_memberships",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    academyId: uuid("academy_id")
      .notNull()
      .references(() => academies.id),
    role: academyRoleEnum("role").notNull(),
    status: membershipStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Database Constraints & Indexes: "academy_memberships: unique
    // (user_id, academy_id)."
    uniqueIndex("academy_memberships_user_id_academy_id_unique").on(
      table.userId,
      table.academyId,
    ),
    // Database Constraints & Indexes' index list: "academy_memberships
    // (academy_id, user_id)" — reversed column order from the unique
    // constraint above, since this index serves "list every member of
    // this academy" lookups rather than "does this user already belong".
    index("academy_memberships_academy_id_user_id_idx").on(
      table.academyId,
      table.userId,
    ),
  ],
);
