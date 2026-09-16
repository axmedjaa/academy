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
 * branch_id are plain nullable uuid columns without FK constraints for
 * now — academies/branches don't exist until Phase 1 (Item 19); a real FK
 * can be added once those tables do.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    actorRole: text("actor_role"),
    academyId: uuid("academy_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    branchId: uuid("branch_id"),
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
