import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
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
