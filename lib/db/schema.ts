import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  numeric,
  timestamp,
  time,
  date,
  pgEnum,
  uniqueIndex,
  index,
  check,
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

// Phase 1, Item 22. PLAN.md's exact column list (Phase 1 §2): "id, name,
// description, price_amount_cents, currency, billing_period, max_branches,
// max_students, max_staff, max_courses, max_storage_bytes, sms_enabled,
// email_enabled, certificate_enabled, reports_level, is_active, created_at,
// updated_at)." PLAN.md doesn't enumerate concrete values for
// billing_period or reports_level anywhere (unlike user_status/
// platform_role/branch_status, which are given explicit value lists) — two
// judgment calls, documented on each enum below.
//
// billing_period must be a fixed, closed set rather than free text: Phase 1
// §6's renewSubscription rule computes "ends_at = max(current ends_at, now)
// + plan.billing_period", i.e. billing_period drives real date arithmetic,
// which only works if its values map to well-defined durations.
// monthly/quarterly/annual are the three periods every mainstream SaaS
// billing model uses; nothing in PLAN.md suggests a fourth (e.g. weekly).
export const billingPeriodEnum = pgEnum("billing_period", [
  "monthly",
  "quarterly",
  "annual",
]);

// reports_level is named "_level" (not "_enabled" like its sibling feature
// flags sms_enabled/email_enabled/certificate_enabled), implying a graded
// tier rather than a boolean — otherwise PLAN.md would have called it
// reports_enabled to match the others. "none/basic/advanced" is the
// smallest tier set that justifies a dedicated level field instead of a
// boolean: "none" for the cheapest plan tier (no reporting), "basic" for
// standard operational reports, "advanced" for the breakdown/export-style
// reporting Phase 1 §3's /platform/reports describes for the platform
// itself — mirrored here as the per-academy-plan feature ceiling.
export const reportsLevelEnum = pgEnum("reports_level", [
  "none",
  "basic",
  "advanced",
]);

export const subscriptionPlans = pgTable(
  "subscription_plans",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    name: text("name").notNull(),
    description: text("description"),
    priceAmountCents: integer("price_amount_cents").notNull(),
    currency: text("currency").notNull(),
    billingPeriod: billingPeriodEnum("billing_period").notNull(),
    maxBranches: integer("max_branches").notNull(),
    maxStudents: integer("max_students").notNull(),
    maxStaff: integer("max_staff").notNull(),
    maxCourses: integer("max_courses").notNull(),
    // bigint, not integer: a plain 4-byte Postgres integer caps at
    // ~2.1 billion, i.e. ~2GB — far too small for a per-academy storage
    // allowance expressed in bytes (a realistic plan tier is tens/hundreds
    // of GB or more). mode: "number" keeps this a plain JS number in app
    // code (safe up to 2^53 bytes, ~9 petabytes — nowhere near a plan
    // limit) rather than forcing bigint arithmetic everywhere it's used.
    maxStorageBytes: bigint("max_storage_bytes", { mode: "number" }).notNull(),
    smsEnabled: boolean("sms_enabled").notNull().default(false),
    emailEnabled: boolean("email_enabled").notNull().default(false),
    certificateEnabled: boolean("certificate_enabled").notNull().default(false),
    reportsLevel: reportsLevelEnum("reports_level").notNull(),
    // Archive & Deactivation Rules' project-wide "archive, never delete"
    // posture (Planning Gaps Resolution §12), applied here via is_active
    // rather than a status enum since is_active is the exact field name
    // PLAN.md's own column list gives — setPlanActive(false) is the
    // "Retire (not delete)" action DESIGN.md's /platform/plans row
    // describes; there is no deletePlan action anywhere in PLAN.md's
    // server-action list.
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Consolidated "Database Constraints & Indexes" only states this
    // nonnegativity rule for `*_amount_cents` columns explicitly, but the
    // same rule is extended here (judgment call) to the per-resource limit
    // columns — a negative allowance has no meaning and would silently
    // break checkAllowance() (a later item) if it ever got past the Zod
    // layer via a direct DB write.
    check("subscription_plans_price_amount_cents_nonnegative", sql`${table.priceAmountCents} >= 0`),
    check("subscription_plans_max_branches_nonnegative", sql`${table.maxBranches} >= 0`),
    check("subscription_plans_max_students_nonnegative", sql`${table.maxStudents} >= 0`),
    check("subscription_plans_max_staff_nonnegative", sql`${table.maxStaff} >= 0`),
    check("subscription_plans_max_courses_nonnegative", sql`${table.maxCourses} >= 0`),
    check("subscription_plans_max_storage_bytes_nonnegative", sql`${table.maxStorageBytes} >= 0`),
  ],
);

// Phase 1, Item 23. PLAN.md's exact column list (Phase 1 §2): "id,
// academy_id, plan_id, status, starts_at, ends_at, trial_ends_at,
// activated_at, suspended_at, cancelled_at, renewed_at, renewed_by,
// created_by, updated_by, notes)" — deliberately no created_at/updated_at
// columns despite every other table in this file having them: PLAN.md's
// lists for academies/subscription_plans explicitly end with "..., created_at"
// / "..., created_at, updated_at", while this one's list ends at "notes" —
// so this table's column set is followed literally rather than assuming
// symmetry with its siblings. `starts_at` is the closest analogue to a
// creation timestamp for this table.
//
// status values mirror the state-transition table (Phase 1 §6, "Subscription
// state machine — exact transition table"): Draft, Trial, Active, Past Due,
// Suspended, Expired, Cancelled. Rendered here as lowercase snake_case
// (draft/trial/active/past_due/suspended/expired/cancelled) to match every
// other status-like enum in this file (user_status, branch_status,
// membership_status) — PLAN.md's table headers use Title Case for
// readability, not as literal identifiers (the same judgment already applied
// to billing_period/reports_level above). The full transition logic (which
// of these are reachable from which, including the two lazily-computed
// entries — Trial->Expired and Active->PastDue->Suspended) lives in
// lib/subscriptions/state-machine.ts, not in this enum.
export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "draft",
  "trial",
  "active",
  "past_due",
  "suspended",
  "expired",
  "cancelled",
]);

export const academySubscriptions = pgTable(
  "academy_subscriptions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    academyId: uuid("academy_id")
      .notNull()
      .references(() => academies.id),
    planId: uuid("plan_id")
      .notNull()
      .references(() => subscriptionPlans.id),
    status: subscriptionStatusEnum("status").notNull().default("draft"),
    // Not null + defaultNow(): every subscription's grace/expiry math is
    // anchored to starts_at (Database Constraints & Indexes: "ends_at >=
    // starts_at; trial_ends_at, when set, >= starts_at"), and this table has
    // no created_at of its own (see comment above) for starts_at to fall
    // back on if it were left nullable.
    startsAt: timestamp("starts_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Nullable: a Draft/Trial subscription that hasn't been priced into a
    // billing period yet has no end date; ends_at is populated once
    // activateAcademy/renewSubscription (Items 24/26/30, not yet built)
    // establish one. The nonnegativity-style check below still holds when
    // ends_at is null — Postgres treats `NULL >= starts_at` as not
    // violating the constraint, so no separate `IS NULL OR` clause is
    // needed (same reasoning PLAN.md's own "when set" qualifier on
    // trial_ends_at implies).
    endsAt: timestamp("ends_at", { withTimezone: true }),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    renewedAt: timestamp("renewed_at", { withTimezone: true }),
    renewedBy: uuid("renewed_by").references(() => users.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    updatedBy: uuid("updated_by").references(() => users.id),
    notes: text("notes"),
  },
  (table) => [
    // Not explicitly listed in Database Constraints & Indexes, but every
    // other academy-scoped table in this file carries an index on
    // academy_id for "list this academy's rows" lookups (see
    // branches_academy_id_idx) — extended here by the same judgment call.
    index("academy_subscriptions_academy_id_idx").on(table.academyId),
    // Database Constraints & Indexes: "academy_subscriptions: ends_at >=
    // starts_at; trial_ends_at, when set, >= starts_at."
    check(
      "academy_subscriptions_ends_at_after_starts_at",
      sql`${table.endsAt} >= ${table.startsAt}`,
    ),
    check(
      "academy_subscriptions_trial_ends_at_after_starts_at",
      sql`${table.trialEndsAt} >= ${table.startsAt}`,
    ),
  ],
);

// Phase 1, Item 25. PLAN.md's exact column list (Phase 1 §2): "id,
// academy_id, subscription_id, amount_cents, currency, payment_method,
// payment_reference, evidence_file_ref nullable, received_at, recorded_by,
// verified_by, status, notes, created_at)" — deliberately no updated_at, no
// verified_at/rejected_at/reversed_at, and (unlike student_payments'
// reversed_payment_id self-FK, Phase 2) no linked-row reversal column:
// PLAN.md §6 states these rows are "append-only with a status field," so
// verify/reject/reverse all flip `status` in place on the same row rather
// than writing a new linked row. The exact moment/actor of a reject or
// reverse (as opposed to record/verify, which the row itself remembers via
// recorded_by/verified_by) lives on that action's audit_logs row instead
// (actor_user_id + created_at + the required `reason`) — this table's own
// columns are exactly PLAN.md's literal list, nothing added for symmetry
// with student_payments' richer reversal shape.
//
// status values (verify/reject/reverse workflow, DESIGN.md §8's
// /platform/payments row actions "Verify / Reject / Reverse"): a row is
// created "pending"; from pending it goes to "verified" (verifySubscriptionPayment,
// stamping verified_by) or "rejected" (rejectSubscriptionPayment, verified_by
// stays null); only a "verified" row can be reversed, to "reversed"
// (reverseSubscriptionPayment) — matching Phase 1 §6's renewSubscription
// precondition text "verify it is status = Verified and not reversed," which
// only makes sense if reversed is a distinct value a previously-verified row
// can move to. "rejected" and "reversed" are both terminal: PLAN.md never
// describes un-rejecting or re-verifying a payment. Lowercase snake_case to
// match every other status-like enum in this file.
export const subscriptionPaymentStatusEnum = pgEnum(
  "subscription_payment_status",
  ["pending", "verified", "rejected", "reversed"],
);

export const subscriptionPayments = pgTable(
  "subscription_payments",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    academyId: uuid("academy_id")
      .notNull()
      .references(() => academies.id),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => academySubscriptions.id),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull(),
    // Judgment call: unlike student_payments.method (Phase 2), which PLAN.md
    // gives an explicit exhaustive value list (`enum(cash, mobile_money,
    // bank_transfer)`), PLAN.md never enumerates concrete values for
    // subscription_payments' payment_method anywhere — the same reasoning
    // already applied to academies.type above (free text, not a pgEnum,
    // when PLAN.md doesn't give a closed value set). Recorded free-text by
    // whoever enters the payment (e.g. "bank_transfer", "mobile_money",
    // "cheque", "cash") rather than constrained to student_payments' set,
    // since a platform-level manual payment can arrive by methods an
    // academy's own students never use (e.g. an international wire).
    paymentMethod: text("payment_method").notNull(),
    paymentReference: text("payment_reference"),
    // Evidence upload is a future interface only (Cross-Cutting Architecture
    // Decisions — no lib/storage module exists yet this phase): stored as a
    // plain nullable file reference/key, not a real upload. Building actual
    // storage is out of scope for this item.
    evidenceFileRef: text("evidence_file_ref"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    recordedBy: uuid("recorded_by")
      .notNull()
      .references(() => users.id),
    verifiedBy: uuid("verified_by").references(() => users.id),
    status: subscriptionPaymentStatusEnum("status")
      .notNull()
      .default("pending"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Database Constraints & Indexes' explicit index list: "subscription_payments(subscription_id)".
    index("subscription_payments_subscription_id_idx").on(
      table.subscriptionId,
    ),
    // Not explicitly listed, but extended here by the same judgment call as
    // academy_subscriptions_academy_id_idx above — every academy-scoped
    // table in this file carries an academy_id lookup index.
    index("subscription_payments_academy_id_idx").on(table.academyId),
    // Non-negativity constraints: "All *_amount_cents columns: nonnegative,
    // except reversal/adjustment rows which are explicitly signed/linked" —
    // this table has no signed reversal row (reverse flips status in place,
    // per the comment above), so amount_cents is unconditionally nonnegative.
    check(
      "subscription_payments_amount_cents_nonnegative",
      sql`${table.amountCents} >= 0`,
    ),
  ],
);

// Phase 1, Item 29. PLAN.md's exact column list (Phase 1 §2): "id,
// academy_id, active_students_count, active_staff_count, branch_count,
// course_count, storage_used_bytes, calculated_at)".
//
// Row model — judgment call: PLAN.md's "Database Constraints & Indexes"
// section lists a unique constraint explicitly for every table that needs
// "one current row" semantics (e.g. academy_memberships' (user_id,
// academy_id)) but names none for academy_usage, and Phase 4 §"Reconciled
// write paths" describes usage as something that gets a "counter
// increment" on events like student enrollment — i.e. an existing row
// being mutated, not a fresh row appended per event. Despite that, this
// table is modeled the same way academy_subscriptions already is in this
// file (no unique-per-academy constraint, "current" = the newest row by
// its own timestamp column, see lib/academies/access-gate.ts's
// checkAcademyAccess "current subscription" lookup) rather than an
// upsert-in-place single row: recalculateUsage (lib/subscriptions/usage.ts)
// is a full, audited recomputation from source-of-truth counts, and
// keeping every recomputation as its own row gives the /platform/usage
// page an actual history of when usage was last (re)computed and what it
// was, for free, with no separate audit-log lookup — consistent with this
// codebase's general preference for append-only records over in-place
// mutation (e.g. subscription_payments' "append-only with a status field"
// rule). Future per-event counter increments (Phase 2+, e.g. student
// enrollment) can still land as a new row the same way; nothing here
// forecloses that.
//
// All five count/byte columns are nonnegative integers/bigint, matching
// subscription_plans' max_* sibling columns (max_storage_bytes bigint,
// mode: "number", for the same >2GB reasoning given there) — a negative
// usage figure has no meaning.
export const academyUsage = pgTable(
  "academy_usage",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    academyId: uuid("academy_id")
      .notNull()
      .references(() => academies.id),
    activeStudentsCount: integer("active_students_count").notNull().default(0),
    activeStaffCount: integer("active_staff_count").notNull().default(0),
    branchCount: integer("branch_count").notNull().default(0),
    courseCount: integer("course_count").notNull().default(0),
    storageUsedBytes: bigint("storage_used_bytes", { mode: "number" })
      .notNull()
      .default(0),
    calculatedAt: timestamp("calculated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Not explicitly listed in Database Constraints & Indexes, but every
    // other academy-scoped table in this file carries an academy_id lookup
    // index (see branches_academy_id_idx/academy_subscriptions_academy_id_idx)
    // — "latest row per academy" (the /platform/usage read path) is exactly
    // the query this serves, paired with calculated_at for the ordering.
    index("academy_usage_academy_id_calculated_at_idx").on(
      table.academyId,
      table.calculatedAt,
    ),
    check(
      "academy_usage_active_students_count_nonnegative",
      sql`${table.activeStudentsCount} >= 0`,
    ),
    check(
      "academy_usage_active_staff_count_nonnegative",
      sql`${table.activeStaffCount} >= 0`,
    ),
    check("academy_usage_branch_count_nonnegative", sql`${table.branchCount} >= 0`),
    check("academy_usage_course_count_nonnegative", sql`${table.courseCount} >= 0`),
    check(
      "academy_usage_storage_used_bytes_nonnegative",
      sql`${table.storageUsedBytes} >= 0`,
    ),
  ],
);

// Phase 1, Item 30. PLAN.md's exact column list (Phase 1 §2): "id,
// subscription_payment_id unique, academy_subscription_id, consumed_at,
// consumed_by" — "the mechanism that makes 'a verified payment can only
// fund one renewal, ever' a hard database guarantee rather than an
// application-logic promise" (PLAN.md's own words, quoted in the comment
// on subscription_payments above this one referencing "renewSubscription
// rule below"). One row per renewal ever performed: `renewSubscription`
// (lib/subscriptions/renew.ts) inserts exactly one of these, inside the
// same transaction that locks and validates the funding
// subscription_payments row, atomically with the academy_subscriptions
// update and the audit write — see that file's module comment for the
// full 7-step algorithm PLAN.md §6 specifies.
//
// subscriptionPaymentId is UNIQUE (not just indexed): this is the actual
// double-spend guard PLAN.md's renewSubscription rule depends on — "the
// table's unique constraint on subscription_payment_id makes a
// double-spend impossible even under a race — the second concurrent
// transaction's insert simply fails." renewSubscription also serializes
// concurrent calls earlier (locking the academy_subscriptions row, then
// the candidate subscription_payments row, both via SELECT ... FOR
// UPDATE) so in practice a racing second call is rejected cleanly before
// ever reaching this INSERT — but the unique constraint is the layer that
// makes the guarantee a real one, independent of the application code
// getting its locking order right.
//
// No `updated_at`/status column: like subscription_payments, this is an
// append-only fact table (a consumption, once recorded, is never edited
// or reversed here — PLAN.md's algorithm has no "un-consume" step;
// reversing the underlying payment via reverseSubscriptionPayment, a
// different item's action, does not touch this table).
export const subscriptionPaymentConsumptions = pgTable(
  "subscription_payment_consumptions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    subscriptionPaymentId: uuid("subscription_payment_id")
      .notNull()
      .references(() => subscriptionPayments.id),
    academySubscriptionId: uuid("academy_subscription_id")
      .notNull()
      .references(() => academySubscriptions.id),
    consumedAt: timestamp("consumed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    consumedBy: uuid("consumed_by")
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    // The double-spend guard itself — see the table-level comment above.
    uniqueIndex(
      "subscription_payment_consumptions_subscription_payment_id_unique",
    ).on(table.subscriptionPaymentId),
    // Not explicitly listed in Database Constraints & Indexes, but
    // extended here by the same judgment call as every other FK-scoped
    // lookup index in this file — "renewal history for this subscription"
    // is exactly the query the /platform/subscriptions page's history
    // view would run.
    index(
      "subscription_payment_consumptions_academy_subscription_id_idx",
    ).on(table.academySubscriptionId),
  ],
);

// Phase 2, Item 33. PLAN.md's exact column list (Phase 2 §2): "id,
// academy_id FK academies NOT NULL, user_id FK users NOT NULL,
// employee_number text nullable, full_name text NOT NULL, phone text NOT
// NULL, email text nullable, hire_date date nullable, status
// enum(active,archived) NOT NULL default active, created_at, updated_at;
// unique (academy_id, user_id); index (academy_id)."
//
// Deliberately no `role` column, even though academy_memberships.role
// (academyRoleEnum, above) exists and Item 35 is literally named
// "assignStaffRole": PLAN.md's own literal column list for staff_profiles
// has no role field, and role/system-access for a staff member is granted
// through their academy_memberships row, not duplicated here. A
// staff_profiles row models the *employment record* — who this person is
// as an employee (employee number, contact details, hire date) — a
// separate concept from academy_memberships, which grants a user a login
// and a role in a given academy. The two rows are linked only loosely (via
// user_id + academy_id, not a direct FK to each other) because PLAN.md
// never lists one; assignStaffRole (Item 35, not this item) is expected to
// operate on the caller's existing academy_memberships row for that
// user/academy. Flagging this here since it's the one place this item's
// brief asked to double-check the literal column list rather than assume
// symmetry with academy_memberships.
export const staffProfiles = pgTable(
  "staff_profiles",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    academyId: uuid("academy_id")
      .notNull()
      .references(() => academies.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    employeeNumber: text("employee_number"),
    fullName: text("full_name").notNull(),
    phone: text("phone").notNull(),
    email: text("email"),
    hireDate: date("hire_date"),
    // Reuses branchStatusEnum (active/archived) rather than declaring a new,
    // value-identical two-value enum. This isn't just a coincidental value
    // match: the Archive & Deactivation Rules table (below, further down
    // this file's conceptual source — see PLAN.md) lists "Staff" as its own
    // row with the exact same "archive, never delete, restorable"
    // active/archived semantics already modeled for "Branches" via
    // branchStatusEnum — the same lifecycle concept, just a different
    // entity. Contrast with membershipStatusEnum above, which deliberately
    // did NOT reuse this enum for a different reason: academy_memberships
    // isn't one of the Archive & Deactivation Rules entities at all, so
    // "archived" would have been the wrong word there. Judgment call/minor
    // naming quirk worth flagging: the underlying Postgres enum type stays
    // named "branch_status" even though it's now shared by a non-branch
    // table. Not renamed here (e.g. to a generic "archive_status") to avoid
    // an unrelated ALTER TYPE migration touching the already-shipped
    // `branches` table as a side effect of this item's schema addition.
    status: branchStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Database Constraints & Indexes doesn't restate this one (it lists
    // staff_branch_assignments' unique constraint but not this table's),
    // but Phase 2 §2's own literal column list for staff_profiles states
    // it directly: "unique (academy_id, user_id)" — one employment record
    // per user per academy.
    uniqueIndex("staff_profiles_academy_id_user_id_unique").on(
      table.academyId,
      table.userId,
    ),
    // Phase 2 §2: "index (academy_id)" — also explicitly repeated in the
    // consolidated Database Constraints & Indexes' index list
    // ("staff_profiles(academy_id)").
    index("staff_profiles_academy_id_idx").on(table.academyId),
  ],
);

// Phase 2, Item 33. PLAN.md's exact column list (Phase 2 §2): "id,
// academy_id FK NOT NULL, staff_profile_id FK staff_profiles NOT NULL,
// branch_id FK branches NOT NULL, created_at; unique
// (staff_profile_id, branch_id)."
//
// The consolidated Database Constraints & Indexes section spells this same
// constraint as "staff_branch_assignments: unique (staff_id, branch_id)" —
// a shorthand referring to the same staff_profile_id column Phase 2 §2's
// own table definition names explicitly (this table has no separate
// `staff_id` column; PLAN.md's own phase-section column lists are treated
// as the more authoritative, literal source everywhere else in this file,
// e.g. academy_subscriptions/academy_usage above, so the same judgment
// applies here).
export const staffBranchAssignments = pgTable(
  "staff_branch_assignments",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    academyId: uuid("academy_id")
      .notNull()
      .references(() => academies.id),
    staffProfileId: uuid("staff_profile_id")
      .notNull()
      .references(() => staffProfiles.id),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex(
      "staff_branch_assignments_staff_profile_id_branch_id_unique",
    ).on(table.staffProfileId, table.branchId),
  ],
);

// document_type's exhaustive value list is given directly in PLAN.md's
// Phase 2 §2 staff_documents column list — a closed set, unlike the
// judgment-call free-text fields elsewhere in this file (academies.type,
// subscription_payments.payment_method). Kept as its own pgEnum rather
// than shared with student_documents' similarly-named document_type
// column (a later, not-yet-built table in this same phase): the two value
// sets differ — student_documents is id_copy/certificate/other, this one
// additionally has "contract" — so they aren't the same enum and can't be
// merged without silently allowing "contract" on a student document.
export const staffDocumentTypeEnum = pgEnum("staff_document_type", [
  "id_copy",
  "certificate",
  "contract",
  "other",
]);

// Phase 2, Item 33. PLAN.md's exact column list (Phase 2 §2): "id,
// academy_id FK NOT NULL, staff_profile_id FK staff_profiles NOT NULL,
// document_type enum(id_copy,certificate,contract,other) NOT NULL,
// file_ref text NOT NULL, uploaded_by FK users NOT NULL, status
// enum(active,archived) NOT NULL default active, created_at; index
// (staff_profile_id)." No updated_at: unlike staff_profiles, PLAN.md's
// literal list for this table ends at created_at (matches the same
// "follow the literal list, don't assume symmetry with a sibling table"
// judgment already applied to academy_subscriptions above).
//
// file_ref is a plain nullable-free text reference, matching
// subscription_payments.evidenceFileRef's judgment call above: no
// lib/storage module exists yet, so this is an interface placeholder, not
// a real upload — building actual storage/upload handling is out of scope
// for this schema-only item (and belongs to uploadStaffDocument, Item
// 35/36, not built here).
//
// status reuses branchStatusEnum for the same reason as
// staffProfiles.status above: "Documents (staff/student)" is its own row
// in the Archive & Deactivation Rules table sharing the identical
// active/archived, "frees storage allowance on archive" lifecycle.
export const staffDocuments = pgTable(
  "staff_documents",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    academyId: uuid("academy_id")
      .notNull()
      .references(() => academies.id),
    staffProfileId: uuid("staff_profile_id")
      .notNull()
      .references(() => staffProfiles.id),
    documentType: staffDocumentTypeEnum("document_type").notNull(),
    fileRef: text("file_ref").notNull(),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id),
    status: branchStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Phase 2 §2: "index (staff_profile_id)".
    index("staff_documents_staff_profile_id_idx").on(table.staffProfileId),
  ],
);

// Phase 2, Item 37. PLAN.md's exact column list (Phase 2 §2): "id,
// academy_id FK academies NOT NULL, branch_id FK branches NOT NULL,
// student_number text NOT NULL, full_name text NOT NULL, date_of_birth date
// nullable, gender text nullable, phone text nullable, email text nullable,
// guardian_name text nullable, guardian_phone text nullable, status
// enum(active,archived) NOT NULL default active, created_by FK users NOT
// NULL, created_at, updated_at; unique (academy_id, student_number); index
// (academy_id), (branch_id)."
//
// gender is free text, not a pgEnum: PLAN.md never gives an exhaustive
// value list for it anywhere (unlike status, which is given directly as
// "enum(active,archived)") — the same judgment already applied to
// academies.type/subscription_payments.paymentMethod above.
//
// status reuses branchStatusEnum (active/archived) rather than a new
// student-specific enum, for the same reason staffProfiles.status did in
// Item 33: the Archive & Deactivation Rules table lists "Students" as its
// own row with the identical archive-never-delete/restorable/
// frees-allowance-slot semantics already modeled by branchStatusEnum for
// branches and reused for staff — the same lifecycle concept, just another
// entity, not a reason to fork a value-identical enum.
export const students = pgTable(
  "students",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    academyId: uuid("academy_id")
      .notNull()
      .references(() => academies.id),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    studentNumber: text("student_number").notNull(),
    fullName: text("full_name").notNull(),
    dateOfBirth: date("date_of_birth"),
    gender: text("gender"),
    phone: text("phone"),
    email: text("email"),
    guardianName: text("guardian_name"),
    guardianPhone: text("guardian_phone"),
    status: branchStatusEnum("status").notNull().default("active"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Phase 2 §2 / Security considerations: "(academy_id, student_number)
    // uniqueness is a DB-level unique constraint" — student IDs are unique
    // within an academy and independent across academies (two academies can
    // both use STD-000001, per the Phase 2 acceptance criteria).
    uniqueIndex("students_academy_id_student_number_unique").on(
      table.academyId,
      table.studentNumber,
    ),
    // Phase 2 §2: "index (academy_id), (branch_id)".
    index("students_academy_id_idx").on(table.academyId),
    index("students_branch_id_idx").on(table.branchId),
  ],
);

// document_type's exhaustive value list is given directly in PLAN.md's
// Phase 2 §2 student_documents column list: id_copy/certificate/other — no
// "contract" (unlike staffDocumentTypeEnum above, which does have
// "contract"). Kept as its own pgEnum rather than reusing
// staffDocumentTypeEnum: the two value sets differ, so sharing one enum
// would silently let a student document be filed with a "contract" type
// that PLAN.md's own column list for this table never allows.
export const studentDocumentTypeEnum = pgEnum("student_document_type", [
  "id_copy",
  "certificate",
  "other",
]);

// Phase 2, Item 37. PLAN.md's exact column list (Phase 2 §2): "id,
// academy_id FK NOT NULL, student_id FK students NOT NULL, document_type
// enum(id_copy,certificate,other) NOT NULL, file_ref text NOT NULL,
// uploaded_by FK users NOT NULL, status enum(active,archived) NOT NULL
// default active, created_at; index (student_id)." No updated_at: PLAN.md's
// literal list ends at created_at, matching the same "follow the literal
// list, don't assume symmetry with a sibling table" judgment already
// applied to staffDocuments/academySubscriptions above.
//
// file_ref is a plain text reference, not a real upload — same
// interface-placeholder judgment call as staffDocuments.fileRef above (no
// lib/storage module exists yet; building actual storage/upload handling is
// out of scope for this schema-only item and belongs to
// uploadStudentDocument, a later item, not this one).
//
// status reuses branchStatusEnum for the same reason staffDocuments.status
// did: "Documents (staff/student)" is its own single row in the Archive &
// Deactivation Rules table, covering both staff and student documents under
// one identical active/archived lifecycle.
export const studentDocuments = pgTable(
  "student_documents",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    academyId: uuid("academy_id")
      .notNull()
      .references(() => academies.id),
    studentId: uuid("student_id")
      .notNull()
      .references(() => students.id),
    documentType: studentDocumentTypeEnum("document_type").notNull(),
    fileRef: text("file_ref").notNull(),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id),
    status: branchStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Phase 2 §2: "index (student_id)".
    index("student_documents_student_id_idx").on(table.studentId),
  ],
);

// Phase 2, Item 40. PLAN.md's exact column list (Phase 2 §2): "id,
// academy_id FK NOT NULL, student_id FK students NOT NULL, card_number text
// NOT NULL, photo_file_ref text nullable, issued_at timestamp NOT NULL,
// issued_by FK users NOT NULL, reprint_count integer NOT NULL default 0,
// status enum(active,archived) NOT NULL default active, created_at; unique
// card_number; index (student_id)." No updated_at: PLAN.md's literal list
// ends at created_at, matching the same "follow the literal list, don't
// assume symmetry with a sibling table" judgment already applied to
// staffDocuments/studentDocuments above.
//
// card_number's uniqueness is deliberately a single global unique index,
// not `(academy_id, card_number)` like students.studentNumber — Database
// Constraints & Indexes states this exactly ("student_id_cards.card_number
// unique", no academy qualifier, unlike the adjacent
// "students: (academy_id, student_number) unique" line right above it in
// that same list) and this item's own brief repeats it explicitly ("it's a
// single unique constraint, not per-academy"). lib/academies/id-cards.ts's
// generateCardNumber() retries on a 23505 from this index rather than
// pre-checking then inserting, the same race-safe pattern
// lib/academies/branches.ts's isUniqueViolation() documents.
//
// photoFileRef is a plain nullable text reference, not a real upload — same
// interface-placeholder judgment call as staffDocuments.fileRef/
// studentDocuments.fileRef above (no lib/storage module exists yet).
//
// status reuses branchStatusEnum for the same reason staffProfiles.status/
// students.status did: "Student ID cards" isn't its own line in the
// Archive & Deactivation Rules table, but the identical active/archived,
// never-hard-deleted lifecycle is the only one this codebase's schema
// convention uses anywhere status is a two-value enum, and reprinting a
// card (issueStudentIdCard again for the same student) is modeled as
// incrementing reprint_count on a fresh active row rather than archiving
// the old one — PLAN.md's brief for this item never describes an
// archive/void action for an individual card, so `status` exists here only
// for schema-convention consistency with every sibling table in this file,
// not because a later item is known to flip it.
export const studentIdCards = pgTable(
  "student_id_cards",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    academyId: uuid("academy_id")
      .notNull()
      .references(() => academies.id),
    studentId: uuid("student_id")
      .notNull()
      .references(() => students.id),
    cardNumber: text("card_number").notNull(),
    photoFileRef: text("photo_file_ref"),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    issuedBy: uuid("issued_by")
      .notNull()
      .references(() => users.id),
    reprintCount: integer("reprint_count").notNull().default(0),
    status: branchStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Database Constraints & Indexes: "student_id_cards.card_number unique"
    // — global, not scoped to academy_id (see the table-level comment above).
    uniqueIndex("student_id_cards_card_number_unique").on(table.cardNumber),
    // Phase 2 §2: "index (student_id)".
    index("student_id_cards_student_id_idx").on(table.studentId),
    check("student_id_cards_reprint_count_nonnegative", sql`${table.reprintCount} >= 0`),
  ],
);

// ===========================================================================
// Phase 3 — Training Operations
// ===========================================================================

// Phase 3, Item 43. PLAN.md's exact column list (Phase 3 §2): "id,
// academy_id FK NOT NULL, name text NOT NULL, description text nullable,
// status enum(active,archived) NOT NULL default active, created_at,
// updated_at; unique (academy_id, name))."
//
// status reuses branchStatusEnum (active/archived) rather than a new
// programs-specific enum — same convention as staffProfiles.status/
// students.status above: PLAN.md's phase intro line for this table group
// ("All tables above: status = archived ... is the only removal path")
// describes the identical archive-never-delete/restorable lifecycle
// branchStatusEnum already models, and PLAN.md's own column list gives
// `programs` the literal same two-value set, not a new one.
export const programs = pgTable(
  "programs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    academyId: uuid("academy_id")
      .notNull()
      .references(() => academies.id),
    name: text("name").notNull(),
    description: text("description"),
    status: branchStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Phase 3 §2: "unique (academy_id, name)".
    uniqueIndex("programs_academy_id_name_unique").on(table.academyId, table.name),
  ],
);

// Phase 3, Item 43. PLAN.md's exact column list (Phase 3 §2): "id,
// academy_id FK NOT NULL, program_id FK programs NOT NULL, name text NOT
// NULL, code text nullable, description text nullable, duration_weeks
// integer nullable, status enum(active,archived) NOT NULL default active,
// created_at, updated_at; unique (academy_id, name); index (program_id))."
//
// courses are academy-wide, like programs — no branch_id column (only
// `batches`, below, is branch-scoped; see this item's own brief).
// status reuses branchStatusEnum for the same reason programs.status does.
export const courses = pgTable(
  "courses",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    academyId: uuid("academy_id")
      .notNull()
      .references(() => academies.id),
    programId: uuid("program_id")
      .notNull()
      .references(() => programs.id),
    name: text("name").notNull(),
    code: text("code"),
    description: text("description"),
    durationWeeks: integer("duration_weeks"),
    status: branchStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Phase 3 §2: "unique (academy_id, name)".
    uniqueIndex("courses_academy_id_name_unique").on(table.academyId, table.name),
    // Phase 3 §2: "index (program_id)".
    index("courses_program_id_idx").on(table.programId),
  ],
);

// Phase 3, Item 43. PLAN.md's exact column list (Phase 3 §2): "id,
// academy_id FK NOT NULL, branch_id FK branches NOT NULL, course_id FK
// courses NOT NULL, name text NOT NULL, code text NOT NULL, start_date date
// NOT NULL, end_date date nullable, status
// enum(planned,active,completed,archived) NOT NULL default planned,
// created_at, updated_at; unique (academy_id, code); index (course_id),
// (branch_id))."
//
// status is a new 4-value enum (planned/active/completed/archived) — no
// existing enum in this file matches that set (branchStatusEnum is only
// active/archived), per this item's own brief.
export const batchStatusEnum = pgEnum("batch_status", [
  "planned",
  "active",
  "completed",
  "archived",
]);

export const batches = pgTable(
  "batches",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    academyId: uuid("academy_id")
      .notNull()
      .references(() => academies.id),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id),
    name: text("name").notNull(),
    code: text("code").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    status: batchStatusEnum("status").notNull().default("planned"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Phase 3 §2: "unique (academy_id, code)".
    uniqueIndex("batches_academy_id_code_unique").on(table.academyId, table.code),
    // Phase 3 §2: "index (course_id), (branch_id)".
    index("batches_course_id_idx").on(table.courseId),
    index("batches_branch_id_idx").on(table.branchId),
  ],
);

// Phase 3, Item 44. PLAN.md's exact column list (Phase 3 §2): "id,
// academy_id FK NOT NULL, batch_id FK batches NOT NULL, staff_profile_id FK
// staff_profiles NOT NULL, assigned_at timestamp NOT NULL, status
// enum(active,removed) NOT NULL default active, created_at; unique
// (batch_id, staff_profile_id))."
//
// status reuses membershipStatusEnum (active/removed) rather than a new
// value-identical enum: PLAN.md's own literal value list for this column
// (active/removed) is exactly membershipStatusEnum's existing two values,
// and "a trainer's assignment to a batch was removed" is the same
// active/removed lifecycle concept academyMemberships already models — not
// the archive/archived lifecycle branchStatusEnum covers for the entities
// in the Archive & Deactivation Rules table (batch_trainer_assignments is
// not one of those; Item 44's own brief confirms membershipStatusEnum "can
// be reused verbatim... same convention Phase 2 used repeatedly").
//
// The unique constraint is a PLAIN (batch_id, staff_profile_id) index, not
// partial/status-scoped — deliberately different from batch_enrollments
// below, whose brief explicitly calls out "unique (student_id, batch_id)
// for active enrollment" (a partial index). No such "for active" qualifier
// appears anywhere in PLAN.md for this table, so re-assigning a previously
// "removed" trainer to the same batch is modeled as reactivating the same
// row in place (flipping status back to "active"), not inserting a second
// row — see lib/academies/batch-assignments.ts's assignTrainerToBatch.
export const batchTrainerAssignments = pgTable(
  "batch_trainer_assignments",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    academyId: uuid("academy_id")
      .notNull()
      .references(() => academies.id),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => batches.id),
    staffProfileId: uuid("staff_profile_id")
      .notNull()
      .references(() => staffProfiles.id),
    assignedAt: timestamp("assigned_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    status: membershipStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("batch_trainer_assignments_batch_id_staff_profile_id_unique").on(
      table.batchId,
      table.staffProfileId,
    ),
  ],
);

// Phase 3, Item 44. PLAN.md's exact column list (Phase 3 §2): "id,
// academy_id FK NOT NULL, batch_id FK batches NOT NULL, student_id FK
// students NOT NULL, enrolled_at timestamp NOT NULL, status
// enum(active,withdrawn,completed) NOT NULL default active, created_at;
// unique (student_id, batch_id) for active enrollment, per Database
// Constraints & Indexes; index (academy_id, student_id))."
//
// status is a new 3-value set (active/withdrawn/completed) — no existing
// enum in this file matches it (membershipStatusEnum is only
// active/removed; batchStatusEnum's four values don't fit either), per this
// item's own brief.
//
// The "unique (student_id, batch_id) for active enrollment" wording
// (repeated verbatim in the consolidated Database Constraints & Indexes
// section, line "batch_enrollments: unique (student_id, batch_id) for
// active enrollments") is a genuine partial unique index — WHERE
// status = 'active' — not a plain table-wide unique constraint: a withdrawn
// enrollment must not block the same student from being enrolled in the
// same batch again later (explicitly required by this item's test list).
// drizzle-kit 0.31.10 supports a partial index via the builder's `.where()`
// (verified against node_modules/drizzle-orm/pg-core/indexes.d.ts —
// `IndexBuilder.where(condition: SQL)`), so this one, unlike grade_bands'
// exclusion constraint, IS fully expressible declaratively here — no
// hand-appended migration SQL needed.
export const batchEnrollmentStatusEnum = pgEnum("batch_enrollment_status", [
  "active",
  "withdrawn",
  "completed",
]);

export const batchEnrollments = pgTable(
  "batch_enrollments",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    academyId: uuid("academy_id")
      .notNull()
      .references(() => academies.id),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => batches.id),
    studentId: uuid("student_id")
      .notNull()
      .references(() => students.id),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    status: batchEnrollmentStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("batch_enrollments_student_id_batch_id_active_unique")
      .on(table.studentId, table.batchId)
      .where(sql`${table.status} = 'active'`),
    // Phase 3 §2: "index (academy_id, student_id)".
    index("batch_enrollments_academy_id_student_id_idx").on(
      table.academyId,
      table.studentId,
    ),
  ],
);

// Phase 3, Item 45. PLAN.md's exact column list (Phase 3 §2): "id,
// academy_id FK NOT NULL, branch_id FK branches NOT NULL, batch_id FK
// batches NOT NULL, day_of_week enum(mon,tue,wed,thu,fri,sat,sun) NOT NULL,
// start_time time NOT NULL, end_time time NOT NULL, room text nullable,
// trainer_staff_profile_id FK staff_profiles nullable, created_at,
// updated_at; check end_time > start_time; no attendance/check-in column
// exists on this table or anywhere else — Decision #21)."
//
// CRITICAL — Decision #21 (PLAN.md, searched verbatim): no attendance/
// check-in concept anywhere. This table has no such column by design, and
// none should ever be added to it or to any sibling table in this phase.
//
// day_of_week's exhaustive value list is given directly in PLAN.md's
// column list (mon..sun) — a closed set, so a real pgEnum, not free text.
export const dayOfWeekEnum = pgEnum("day_of_week", [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
]);

export const timetables = pgTable(
  "timetables",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    academyId: uuid("academy_id")
      .notNull()
      .references(() => academies.id),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => batches.id),
    dayOfWeek: dayOfWeekEnum("day_of_week").notNull(),
    // PLAN.md gives these as bare `time` columns (no timezone) — a weekly
    // recurring slot ("every Monday 09:00–10:00") is wall-clock time at the
    // branch's location, not an instant, unlike every `timestamp` column
    // elsewhere in this file (all declared `{ withTimezone: true }`).
    // drizzle-orm's pg-core `time()` builder maps directly to Postgres
    // `time` (no timezone) by default.
    startTime: time("start_time").notNull(),
    endTime: time("end_time").notNull(),
    room: text("room"),
    trainerStaffProfileId: uuid("trainer_staff_profile_id").references(
      () => staffProfiles.id,
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("timetables_academy_id_idx").on(table.academyId),
    index("timetables_branch_id_idx").on(table.branchId),
    index("timetables_batch_id_idx").on(table.batchId),
    // PLAN.md §2: "check end_time > start_time".
    check("timetables_end_time_after_start_time", sql`${table.endTime} > ${table.startTime}`),
  ],
);

// Phase 3, Item 46. PLAN.md's exact column list (Phase 3 §2): "id,
// academy_id FK NOT NULL, name text NOT NULL, status
// enum(draft,pending_approval,approved,active,retired) NOT NULL default
// draft, created_by FK users NOT NULL, approved_by FK users nullable,
// approved_at timestamp nullable, activated_at timestamp nullable,
// retired_at timestamp nullable, created_at, updated_at; index
// (academy_id, status))."
//
// The full Draft -> Pending Approval -> Approved -> Active/Retired
// approval FLOW (submitGradeConfigForApproval/approveGradeConfig) is a
// later item, not this one — this item only builds the schema + the
// exclusion-constraint validation + plain-CRUD createGradeConfiguration/
// updateGradeBands in `draft` status (see lib/academies/
// grade-configurations.ts's module comment).
export const gradeConfigurationStatusEnum = pgEnum("grade_configuration_status", [
  "draft",
  "pending_approval",
  "approved",
  "active",
  "retired",
]);

export const gradeConfigurations = pgTable(
  "grade_configurations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    academyId: uuid("academy_id")
      .notNull()
      .references(() => academies.id),
    name: text("name").notNull(),
    status: gradeConfigurationStatusEnum("status").notNull().default("draft"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Phase 3 §2: "index (academy_id, status)".
    index("grade_configurations_academy_id_status_idx").on(table.academyId, table.status),
  ],
);

// Phase 3, Item 46. PLAN.md's exact column list (Phase 3 §2): "id,
// grade_configuration_id FK grade_configurations NOT NULL, label text NOT
// NULL, min_mark numeric NOT NULL, max_mark numeric NOT NULL, is_pass
// boolean NOT NULL, created_at; check max_mark >= min_mark; exclusion
// constraint via btree_gist on (grade_configuration_id,
// numrange(min_mark, max_mark)) — mandatory on every configuration
// regardless of status, not just active ones."
//
// IMPORTANT — read before touching this table: the no-overlap guarantee
// for grade bands within a configuration is NOT fully expressed by this
// Drizzle table definition. drizzle-orm 0.45.2 / drizzle-kit 0.31.10 have
// no declarative builder for a Postgres `EXCLUDE USING gist` constraint
// (verified: no `ExcludeConstraint`/"EXCLUDE USING" API anywhere in
// node_modules/drizzle-orm or drizzle-kit) — only `check()`/`uniqueIndex()`
// are supported, neither of which can express "no two rows for the same
// grade_configuration_id may have overlapping numeric ranges." The `check`
// constraint below (max_mark >= min_mark) IS fully expressed here, but the
// exclusion constraint itself was hand-appended to the generated migration
// SQL file (drizzle/0013_*.sql — see that file's trailing statements) as:
//   CREATE EXTENSION IF NOT EXISTS btree_gist;
//   ALTER TABLE grade_bands ADD CONSTRAINT grade_bands_no_overlap
//     EXCLUDE USING gist (grade_configuration_id WITH =, numrange(min_mark, max_mark) WITH &&);
// A future `db:generate` run will NOT know this constraint exists (it's
// invisible to drizzle-kit's introspection of this schema.ts file), so
// do not be surprised if a later diff doesn't mention it — check the
// database/migration SQL directly, not this file alone, when reasoning
// about grade_bands' actual constraints.
export const gradeBands = pgTable(
  "grade_bands",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    gradeConfigurationId: uuid("grade_configuration_id")
      .notNull()
      .references(() => gradeConfigurations.id),
    label: text("label").notNull(),
    minMark: numeric("min_mark").notNull(),
    maxMark: numeric("max_mark").notNull(),
    isPass: boolean("is_pass").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("grade_bands_max_mark_gte_min_mark", sql`${table.maxMark} >= ${table.minMark}`),
  ],
);

// Phase 3, Item 50a. PLAN.md's exact column list (Phase 3 §2): "id,
// academy_id FK academies NOT NULL, entity_type
// enum(result,grade_configuration,expense,student_payment) NOT NULL,
// entity_id uuid NOT NULL, requested_by FK users NOT NULL, status
// enum(pending,approved,rejected) NOT NULL default pending, reason text
// nullable, decided_by FK users nullable, decided_at timestamp nullable,
// created_at; index (entity_type, entity_id), (academy_id, status))."
//
// Single reusable table for the whole app's approval workflow (Cross-
// Cutting Architecture Decisions: "single reusable approval_requests
// table, introduced in Phase 3 (results/grades) and reused in Phase 4
// (finance)") — entity_type's value list includes `expense`/
// `student_payment` now even though neither is used until Phase 4, per
// PLAN.md's own literal column list for this table (not scope creep: the
// enum values are schema, not behavior — no Phase 4 logic is built here).
//
// entity_id is a bare polymorphic uuid with deliberately NO foreign key:
// it points at a different table depending on entity_type
// (exam_results/grade_configurations this phase, expense_records/
// student_payments in Phase 4) — a single FK target isn't possible, and
// PLAN.md's column list itself gives entity_id no FK reference (contrast
// with every other *_id column on this table, which are all FKs).
export const approvalRequestEntityTypeEnum = pgEnum("approval_request_entity_type", [
  "result",
  "grade_configuration",
  "expense",
  "student_payment",
]);

export const approvalRequestStatusEnum = pgEnum("approval_request_status", [
  "pending",
  "approved",
  "rejected",
]);

export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    academyId: uuid("academy_id")
      .notNull()
      .references(() => academies.id),
    entityType: approvalRequestEntityTypeEnum("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id),
    status: approvalRequestStatusEnum("status").notNull().default("pending"),
    reason: text("reason"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Phase 3 §2: "index (entity_type, entity_id), (academy_id, status)".
    index("approval_requests_entity_type_entity_id_idx").on(
      table.entityType,
      table.entityId,
    ),
    index("approval_requests_academy_id_status_idx").on(table.academyId, table.status),
  ],
);

// Phase 3, Item 48. PLAN.md's exact column list (Phase 3 §2): "id,
// academy_id FK NOT NULL, batch_id FK batches NOT NULL, name text NOT NULL,
// max_marks numeric NOT NULL, exam_date date nullable, status
// enum(scheduled,marks_entry,completed,archived) NOT NULL default
// scheduled, created_at, updated_at; index (batch_id))."
//
// max_marks nonnegativity: not explicitly stated by PLAN.md for this table
// (unlike e.g. subscription_plans' max_* columns), but added here by the
// same judgment call already applied to every other numeric allowance/limit
// column in this file (see subscription_plans' comment) — a negative
// max_marks has no meaning and would silently break enterMarks'
// marks_obtained-vs-max_marks range check (lib/academies/exams.ts) if it
// ever got past the Zod layer via a direct DB write.
export const examStatusEnum = pgEnum("exam_status", [
  "scheduled",
  "marks_entry",
  "completed",
  "archived",
]);

export const exams = pgTable(
  "exams",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    academyId: uuid("academy_id")
      .notNull()
      .references(() => academies.id),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => batches.id),
    name: text("name").notNull(),
    maxMarks: numeric("max_marks").notNull(),
    examDate: date("exam_date"),
    status: examStatusEnum("status").notNull().default("scheduled"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Phase 3 §2: "index (batch_id)".
    index("exams_batch_id_idx").on(table.batchId),
    check("exams_max_marks_nonnegative", sql`${table.maxMarks} >= 0`),
  ],
);

// Phase 3, Item 48. PLAN.md's exact column list (Phase 3 §2): "id,
// academy_id FK NOT NULL, exam_id FK exams NOT NULL, student_id FK students
// NOT NULL, batch_id FK batches NOT NULL — denormalized, required for the
// Phase 5 certificate-eligibility query — marks_obtained numeric nullable,
// grade_configuration_id FK grade_configurations NOT NULL (snapshotted at
// publish time, never updated after), grade_band_label text nullable
// (snapshotted), pass_fail enum(pending,pass,fail) NOT NULL default
// pending, status enum(draft,marks_entered,submitted,under_review,approved,
// rejected,published) NOT NULL default draft, entered_by FK users NOT
// NULL, submitted_at timestamp nullable, approved_by FK users nullable,
// approved_at timestamp nullable, published_at timestamp nullable,
// created_at, updated_at; unique (exam_id, student_id); index
// (academy_id, batch_id), (student_id))."
//
// ---------------------------------------------------------------------
// CRITICAL — grade_configuration_id timing (Item 48's own judgment call,
// documented here since it directly constrains what Item 49 must do)
// ---------------------------------------------------------------------
// This column is NOT NULL, yet PLAN.md's own comment on it says it is
// "snapshotted at publish time, never updated after" — and publish
// (publishResults) is Item 49, not this one. The Result Lifecycle table
// (PLAN.md, Lifecycle & State-Transition Tables) resolves this: the FIRST
// row this table ever gets is written by `createExam` itself ("— -> Draft
// | createExam implicitly creates a Draft exam_results row per enrolled
// student | system, on exam creation"), not by `enterMarks`. Since the
// column is NOT NULL, `createExam` (lib/academies/exams.ts) must therefore
// populate it at that same moment — it sets it to the academy's currently
// `active` grade_configuration (a hard precondition: createExam refuses
// with an explicit error if the academy has none), NOT a value enterMarks
// invents later. This is a *working/placeholder* value, not the true
// snapshot: nothing in this column is immutable until `Published` (see the
// "Immutable fields once Published" note right after that lifecycle table),
// so Item 49's publishResults is still free — and, per that same
// "snapshotted at publish time" wording, still REQUIRED — to overwrite it
// with whatever configuration is active at the actual moment of publish
// before locking it. `enterMarks` (Draft -> Marks Entered) never touches
// this column for a pre-existing row; the one exception is the late-
// enrollment edge case documented on `enterMarks` itself (lib/academies/
// exams.ts), where a student enrolled after `createExam` already ran has no
// row yet — `enterMarks` inserts one there and, needing the same NOT NULL
// value, applies the identical "academy's current active configuration,
// hard precondition" rule createExam already uses.
//
// pass_fail/grade_band_label are deliberately left at their defaults
// (`pending`/`null`) by both createExam and enterMarks — PLAN.md's own
// default for pass_fail is `pending`, and evaluating marks_obtained against
// grade_bands is described as part of the publish/approval machinery (Item
// 49), not marks entry. Out of this item's scope by design.
export const examResultPassFailEnum = pgEnum("exam_result_pass_fail", [
  "pending",
  "pass",
  "fail",
]);

export const examResultStatusEnum = pgEnum("exam_result_status", [
  "draft",
  "marks_entered",
  "submitted",
  "under_review",
  "approved",
  "rejected",
  "published",
]);

export const examResults = pgTable(
  "exam_results",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    academyId: uuid("academy_id")
      .notNull()
      .references(() => academies.id),
    examId: uuid("exam_id")
      .notNull()
      .references(() => exams.id),
    studentId: uuid("student_id")
      .notNull()
      .references(() => students.id),
    // Denormalized from the exam's own batch_id — PLAN.md's own words:
    // "required for the Phase 5 certificate-eligibility query" (that later
    // query needs "does this (student_id, batch_id) have a Published pass
    // result" without joining through exams at all).
    batchId: uuid("batch_id")
      .notNull()
      .references(() => batches.id),
    marksObtained: numeric("marks_obtained"),
    gradeConfigurationId: uuid("grade_configuration_id")
      .notNull()
      .references(() => gradeConfigurations.id),
    gradeBandLabel: text("grade_band_label"),
    passFail: examResultPassFailEnum("pass_fail").notNull().default("pending"),
    status: examResultStatusEnum("status").notNull().default("draft"),
    enteredBy: uuid("entered_by")
      .notNull()
      .references(() => users.id),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Phase 3 §2: "unique (exam_id, student_id)".
    uniqueIndex("exam_results_exam_id_student_id_unique").on(
      table.examId,
      table.studentId,
    ),
    // Phase 3 §2: "index (academy_id, batch_id), (student_id)".
    index("exam_results_academy_id_batch_id_idx").on(table.academyId, table.batchId),
    index("exam_results_student_id_idx").on(table.studentId),
    // Not stated explicitly by PLAN.md for this column, but added here by
    // the same nonnegativity judgment call as exams.max_marks above — a
    // negative marks_obtained has no meaning. The complementary
    // "marks_obtained <= exam.max_marks" rule is NOT expressed as a DB
    // constraint (a cross-table check needs a trigger, not a plain `check`
    // builder) — it's enforced in application logic by
    // lib/academies/exams.ts's `enterMarks`, documented there.
    check("exam_results_marks_obtained_nonnegative", sql`${table.marksObtained} >= 0`),
  ],
);

// Phase 3, Item 50b. PLAN.md's exact column list (Phase 3 §2): "id,
// academy_id FK NOT NULL, original_result_id FK exam_results NOT NULL,
// requested_by FK users NOT NULL, reason text NOT NULL,
// proposed_marks_obtained numeric nullable, status
// enum(requested,approved,rejected,applied) NOT NULL default requested,
// decided_by FK users nullable, decided_at timestamp nullable, applied_at
// timestamp nullable, created_at; index (original_result_id)."
//
// ---------------------------------------------------------------------
// Conceptual "Correction Requested" state — NOT a new exam_results.status
// value
// ---------------------------------------------------------------------
// The Result Lifecycle table's "Published -> Correction Requested" row
// might read as if exam_results.status needs a new enum member, but
// examResultStatusEnum's literal column list (see the comment on
// `examResults` above) never changes — "Correction Requested" is derived
// at read time from "does this result have a `result_corrections` row with
// status = 'requested'", not a status this table's own enum stores. The
// underlying exam_results row stays `status = "published"` throughout the
// whole correction process (request -> decide -> apply); only this table's
// own `status` column moves through requested/approved/rejected/applied.
// See lib/academies/result-corrections.ts's module comment for the full
// reasoning, including how this integrates with `approval_requests`
// (Item 50a) despite that table's entity_type enum having no
// "result_correction" value of its own.
export const resultCorrectionStatusEnum = pgEnum("result_correction_status", [
  "requested",
  "approved",
  "rejected",
  "applied",
]);

export const resultCorrections = pgTable(
  "result_corrections",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    academyId: uuid("academy_id")
      .notNull()
      .references(() => academies.id),
    originalResultId: uuid("original_result_id")
      .notNull()
      .references(() => examResults.id),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id),
    reason: text("reason").notNull(),
    proposedMarksObtained: numeric("proposed_marks_obtained"),
    status: resultCorrectionStatusEnum("status").notNull().default("requested"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Phase 3 §2: "index (original_result_id)".
    index("result_corrections_original_result_id_idx").on(table.originalResultId),
    // Not stated explicitly by PLAN.md for this column, but the same
    // nonnegativity judgment call as exam_results.marks_obtained above —
    // applied consistently since a proposed correction is still a mark.
    check(
      "result_corrections_proposed_marks_obtained_nonnegative",
      sql`${table.proposedMarksObtained} >= 0`,
    ),
  ],
);
