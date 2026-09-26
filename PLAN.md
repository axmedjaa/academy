# Academy Management SaaS — MVP Implementation Plan

## Context

The user supplied a 15-page Technical & Product Report (`academy_management_saas_mvp_full_report.pdf`) specifying a multi-tenant Academy Management SaaS for skills-training academies in Somalia (English, USD). The report is the source of truth for scope, data model, roles, security rules, and phase sequencing (Phase 0 Foundation → 1 SaaS Core → 2 Academy Operations → 3 Training Operations → 4 Finance → 5 Credentials & Release).

A second document, `academy_management_saas_missing_requirements_report.pdf`, was later reviewed against the original report and this plan, producing `REQUIREMENTS_GAP_ANALYSIS.md`. That analysis classified every item in the second report and surfaced 17 open decisions (3 of them genuine conflicts with the original design). **All 17 have now been resolved** (see "Decisions Incorporated" below) and are folded into this revision of `PLAN.md`. `REQUIREMENTS_GAP_ANALYSIS.md` remains the record of *why* each addition exists; this file is the current, authoritative implementation plan.

This is a **greenfield project** — no code exists yet. **No code will be written until this plan is approved.**

Confirmed technical decisions (from the report + earlier user answers):

- Next.js full-stack, TypeScript, PostgreSQL, Drizzle ORM + Drizzle Kit, Zod validation.
- **Authentication is fully custom** — email/password, Argon2id hashing, server-generated session tokens stored hashed in Postgres, secure HTTP-only cookies. No Auth.js/Better Auth/Clerk/third-party auth service.
- **Redis is provisioned from Phase 0** — used immediately for login/password-reset rate limiting; BullMQ (same Redis) is wired in Phase 0 but its first real queue/worker is built in Phase 5 for notifications.
- Deployment target is undecided — file storage and email/SMS providers are built behind small interfaces (`lib/storage`, `lib/email`, `lib/sms`). **No Docker/containers anywhere in local dev** — Local dev runs natively on Windows: PostgreSQL via its official Windows installer, and Redis via Memurai (a Redis-protocol-compatible native Windows service). File storage uses a local-disk or MinIO-compatible storage adapter.
- Money stored as integer minor units (`*_amount_cents`, integer), never floats.
- Primary keys: UUID (`gen_random_uuid()`).
- No hard deletes on posted financial/result records — reversal/correction rows only.
- Tenant isolation is **application-layer mandatory**; Postgres RLS is an optional Phase 5 hardening addition.

---

## Planning Authority & Source of Truth

`PLAN.md` is the sole implementation authority for this project. `REQUIREMENTS_GAP_ANALYSIS.md`, `academy_management_saas_remaining_planning_gaps.md`, and `PLANNING_GAPS_RESOLUTION.md` are historical/reference documents — they record *why* a decision was made but are never consulted to resolve an implementation ambiguity once this file states an answer. `DESIGN.md`/`DESIGN_PROMPT.md` are authoritative for UI/UX only (screens, navigation, layout, components, states, copy) and explicitly defer to this file wherever they overlap on data model, server actions, or business-rule enforcement. If any two documents are ever found to disagree, `PLAN.md` wins, and implementation on the affected item stops until this file is updated — no code proceeds against an unresolved contradiction.

---

## Decisions Incorporated from Remaining Planning Gaps Review

A third audit, `academy_management_saas_remaining_planning_gaps.md`, reviewed this plan for implementation-readiness (as opposed to scope completeness, which the previous audit covered) and raised 22 items. All 22 are resolved — full reasoning in `PLANNING_GAPS_RESOLUTION.md` — and folded in throughout this revision:

1. **Permission contradiction**: resolved as `platform_owner`-only for academy approval/activation/suspension/reactivation/cancellation/closure, subscription renewal, and payment verification/reject/reversal — never satisfiable by any `platform_admin` grant. See the Master Permission Matrix below.
2. **Authoritative source**: this file, per the section above.
3. **Phase 2–5 schemas**: every table now has a full column specification (see each phase's "Database tables" subsection).
4–7. **Result, grade-configuration, finance, and certificate lifecycles**: formalized as explicit state-transition tables — see "Lifecycle & State-Transition Tables" below.
8. **File storage limits**: see "File Storage Operational Limits" below.
9. **Pagination/search/export limits**: see "Pagination, Search & Export Limits" below.
10. **Notification/queue policies**: see the expanded Phase 5 Notifications subsections.
11. **Account & membership lifecycle**: see "Account & Membership Lifecycle" below.
12. **Archive/deactivation rules**: see "Archive & Deactivation Rules" below.
13. **Database-level tenant protection**: RLS stays deferred post-MVP, with explicit reasoning — see "Database-Level Tenant Protection" below.
14. **Transaction boundaries**: see "Transaction Boundaries" below.
15. **Concurrency & idempotency beyond renewal**: see "Concurrency & Idempotency" below.
16. **API/server-action contract**: see "API & Server-Action Contract" below.
17. **Observability**: see "Observability Requirements" below.
18. **Deployment/ops decisions**: formalized as an explicit deferred-decisions table in the Release Checklist.
19. **Privacy & retention**: see "Privacy & Data Retention" below.
20. **Seed/demo data**: expanded — see "Seed & Demonstration Data" in the Release Checklist.
21. **Acceptance criteria**: tightened throughout each phase.
22. **Final approval checklist**: added as the closing section of this file.

---

## Decisions Incorporated from Requirements Gap Analysis

These 17 decisions were made explicitly by the user (see `REQUIREMENTS_GAP_ANALYSIS.md` §12 for the full reasoning) and now shape the phases below:

1. **Academy status**: no independent `academies.status` lifecycle. `academy_subscriptions.status` remains the single source of truth for access; `academies.closed_at` is the only new field, marking a permanent, separate "closed" state.
2. **Academy closure**: archive model — data retained indefinitely, read-only, never deleted or anonymized. Certificates stay verifiable forever.
3. **MFA**: mandatory TOTP for `platform_owner` only, for MVP. Other roles unaffected.
4. **Bulk import**: out of scope — not built.
5. **Allowance enforcement**: hard block on all capped resources (branches/students/staff/courses/storage).
6. **Downgrade**: blocked entirely while usage exceeds the target plan's limits.
7. **Grace period**: `Past Due` is the grace period; auto-transitions to `Suspended` after 7 days, computed at access-check time (no background job needed).
8. **Ungrantable capabilities**: subscription-plan pricing management, platform-wide revenue reports, **and platform staff/permission-grant management** are permanently `platform_owner`-only, never grantable to a `platform_admin`. **Superseded** by "Decisions Incorporated from Remaining Planning Gaps Review" item 1 above, which expands this set to also include every academy-lifecycle and payment-verification action — treat that section, the Master Permission Matrix, and the Cross-Cutting Architecture Decisions permission-engine bullet as current; this entry is kept only as the historical record of the original three-capability decision.
9. **Academy profile edits**: direct edit by Owner/Admin, no approval workflow.
10. **Export scope**: CSV export on Reports, Student list, Finance, and Audit logs (platform + academy).
11. **Suspicious login**: flagged when a session's IP/user-agent hasn't been seen before for that user (no geolocation).
12. **Password policy**: minimum 8 characters, no forced expiry.
13. **Notification templates**: fixed, code-defined per event (no admin-editable template table).
14. **Support process**: external only (email/phone) — no in-product support/contact feature.
15. **`/academy/audit-logs`**: added, visible to Academy Owner/Admin only.
16. **Permission groups**: UI-only presets over the existing per-capability grant table — no new schema.
17. **Notification event catalog**: full catalog built in Phase 5 (not a trimmed subset).

---

## Cross-Cutting Architecture Decisions

- **Identity model**: one global `users` table. Platform access via `platform_memberships` (`platform_owner` | `platform_admin`); academy access via `academy_memberships` (academy_id, role, status).
- **Session/tenant context**: every server action resolves a trusted `AuthContext` server-side: `{ userId, platformRole?, academyId?, academyRole?, branchIds[], academyWide: boolean }`. The browser never supplies `academyId` for authorization.
- **Permission engine**: static role → capability map (report §22 academy matrix, §3A platform capabilities), plus a `platform_admin` override table for explicit, non-inherited grants. A fixed set of **ungrantable capabilities** bypasses the grant table entirely and always requires `platform_owner`, enforced inside `hasPermission()` itself, not by policy convention: `plans.manage`, `platform.revenue.view`, `platform.staff.manage`, and every academy-lifecycle/payment-verification action — academy registration, academy approval, academy activation, academy suspension, academy reactivation, academy cancellation, academy closure, subscription renewal, and subscription-payment verification/rejection/reversal (Planning Gaps Resolution §1; the same full set is listed in the Master Permission Matrix below — never state this set as a specific count, since its membership, not its size, is the authoritative rule). `platform.staff.manage` covers creating/managing platform staff accounts and granting/revoking any platform permission (including a `platform_admin`'s own grants) — a `platform_admin` can never manage staff or grants, regardless of what else they've been granted, to prevent privilege-escalation via a self- or peer-granted staff-management capability. A single `hasPermission(context, capability, resource?)` function is the only path to authorization.
- **Audit log**: single `audit_logs` table (`academy_id` nullable) with actor_user_id, **actor_role**, action, entity_type, entity_id, **branch_id** (nullable), before/after JSON, **context** (jsonb, nullable), **reason** (nullable — administrative note/rejection reason, distinct from `context`), **request_id** (nullable — correlates all audit rows written during one request/action for tracing), **result** (success/failure), **failure_reason** (nullable), ip, user_agent, timestamp. One `recordAudit()` helper used everywhere, including exports, session revocations, MFA events, and academy closure. **The audit write happens in the same database transaction as the mutation it protects** — a sensitive action's transaction commits only if its audit row is written successfully; there is no code path where a sensitive mutation succeeds without a matching audit record. Before/after JSON is redacted through the same rule as the structured logger (§Phase 0 security): never passwords, tokens, password hashes, MFA secrets/recovery codes, or raw payment-evidence file contents — only metadata (e.g. a file reference, not the file bytes).
- **Approval workflow**: single reusable `approval_requests` table, introduced in Phase 3 (results/grades) and reused in Phase 4 (finance).
- **Allowance enforcement**: a single `checkAllowance(academyId, resource)` helper (`lib/subscriptions/`) is called at the top of every capped-resource create action (branches, staff, students, courses, storage uploads) from Phase 1 onward. Hard block — the action fails with a clear error if the academy is at its plan limit. A plan **downgrade** is itself blocked server-side if current usage exceeds the target plan's limits. "Storage" specifically means academy-owned files — student/staff documents, ID card photos, academy logo; platform-administrative files (e.g. subscription-payment evidence, Phase 1) are stored separately and are never counted against an academy's plan storage allowance.
- **File lifecycle rules** (apply to every academy-owned upload, Phase 1's logo field through Phase 2's documents): max individual file size and allowed MIME types are enforced by a shared Zod schema before any upload begins; a **failed** upload never consumes allowance, and any partially-written object from a failed upload is cleaned up (not left as an orphaned billable object). **No versioning for MVP** — replacing a file (e.g. re-uploading a student's ID photo) deletes the old object and allowance is freed immediately; only one active file per document slot, keeping storage accounting simple and avoiding double-counting. Deleted/replaced files are hard-removed from the storage backend (not soft-deleted or retained) — this is about *file* lifecycle, not the "no hard delete" principle, which applies to financial/result *records*, not attachments. Files are private by default (signed, time-limited download URLs; never a public bucket) and every download is tenant-scoped through `checkAllowance`'s sibling authorization path, never a static public URL. A periodic reconciliation job (Phase 5 monitoring) compares `academy_usage.storage_used_bytes` against actual object-storage contents and flags drift rather than silently trusting the counter.
- **MFA**: TOTP-based, mandatory for `platform_owner` accounts only. Enrollment is forced on first login if not yet enrolled. Recovery codes are single-use, hashed with SHA-256 (not Argon2id — they're high-entropy random values, not user-chosen secrets).
- **Password policy**: minimum 8 characters, enforced by a shared Zod schema used everywhere a password is set.
- **Validation**: every server action has a Zod schema for its input.
- **DB access**: only through Drizzle; all academy-scoped tables carry `academy_id`, branch-specific ones also carry `branch_id`.

---

## Master Permission Matrix

Consolidated, action-level reference — every cell below is already implied by the individual phase sections; this table exists so authorization can be implemented and reviewed against one place rather than reconstructed by re-reading every phase. `Full` = create/edit/delete-equivalent(archive); `Manage` = create/edit within scope; `View` = read-only; `Approve` = decision-making on submitted items; `Per grant` = only if explicitly granted via `platform_admin_permissions`; `—` = never visible/callable, not merely hidden. Roles are exactly the 8 defined by the original report and used throughout this plan — no roles are added or renamed.

**Platform-level actions**

| Action | Platform Owner | Platform Admin |
|---|---|---|
| Register / approve academy | Full | **— (never grantable)** |
| Activate / suspend / reactivate / cancel academy | Full | **— (never grantable)** |
| **Close academy (permanent)** | Full | **— (never grantable)** |
| Renew subscription | Full | **— (never grantable)** |
| Record subscription payment | Full | Per grant |
| **Verify / reject / reverse subscription payment** | Full | **— (never grantable)** |
| **Manage subscription plans (pricing)** — `plans.manage` | Full | **— (never grantable)** |
| **View platform-wide revenue reports** — `platform.revenue.view` | Full | **— (never grantable)** |
| **Manage platform staff accounts / grant or revoke any platform permission** — `platform.staff.manage` | Full | **— (never grantable)** |
| View platform audit logs | Full | Per grant |
| View platform usage & non-revenue reports | Full | Per grant |

**Every lifecycle-mutating and payment-verifying action on this table is permanently `platform_owner`-only** (Planning Gaps Resolution §1) — enforced inside `hasPermission()` itself, never satisfiable by any grant, and matching the state-transition table's actor column in Phase 1 §6 exactly (there is no admin actor path anywhere in that table). A granted `platform_admin` may only: record a subscription payment (the low-risk data-entry half of the payment flow — verifying/reversing it is still owner-only), view platform audit logs, and view non-revenue usage/reports. This is a narrower grantable surface than earlier revisions of this plan — see `PLANNING_GAPS_RESOLUTION.md` §1 for why the correction was made.

**Academy-level actions** (scope column: `academy-wide` roles skip branch filtering; `branch-limited` roles — Admissions Officer, Trainer — see only their assigned branch(es), per Phase 2 §6)

| Action | Academy Owner | Academy Admin | Manager | Admissions | Finance | Trainer | Scope for branch-limited roles |
|---|---|---|---|---|---|---|---|
| Academy settings (direct edit) | Full | Full | View/Edit | — | — | — | n/a (academy-wide only) |
| Branches | Full | Full | Manage | View | — | View | assigned |
| Staff | Full | Full | Manage | — | — | View self/assigned | assigned |
| Students / admissions | Full | Full | Manage | Manage | View | View assigned | assigned |
| Student ID cards | Full | Manage | Manage | Manage | — | — | assigned |
| Courses / batches | Full | Full | Manage | View | — | Manage assigned | assigned |
| Grade-band configuration | Full | Manage | Manage/Approve | — | — | — | n/a |
| Exam mark entry | Full | Full | Manage | — | — | Enter marks (assigned batches only) | assigned |
| Result approve / reject / publish | Approve | Approve | Approve | — | — | Submit only | n/a |
| Result correction request | Same authority as submit/approve above — no separate role | | | | | | |
| Student payments (record) | View | View | Approve/Manage | — | Manage (not own) | View | n/a |
| Expenses (create/approve) | View | Approve | Approve | — | Create/Submit | View | n/a |
| Reversal / adjustment | Same approval authority as the underlying transaction type; the recorder can never approve their own | | | | | | |
| Certificates (issue/cancel) | Full | Manage | Manage | — | — | View | n/a |
| Academy audit log (view) | Full | Full | — | — | — | — | n/a (Owner/Admin only, Decision #15) |
| Export (Reports/Students/Finance/Audit) | Per own view rights above — export never exceeds what the role can already see on-screen | | | | | | |

This matches the original report's §22 matrix and `DESIGN.md`'s §5 role-visibility matrix exactly — no capability here is new, and none of the two documents' matrices are permitted to diverge from this one going forward.

---

## Phase 0 — Foundation

**1. What we're building**
Project scaffold, Postgres + Drizzle + migrations, environment/config management, structured logging, Redis connection, custom auth (login/logout/password reset, Argon2id, session cookies, **mandatory TOTP MFA for platform owners**, **session listing/revocation**, **suspicious-login detection**), tenant/permission context resolution, audit log utility, CI, and a Vitest/Playwright baseline.

**2. Database tables**
- `users` (id, email unique, password_hash, status, failed_login_attempts, locked_until, last_login_at, created_at, updated_at)
- `sessions` (id, user_id, token_hash, expires_at, revoked_at, ip, user_agent, created_at)
- `password_reset_tokens` (id, user_id, token_hash, expires_at, used_at, created_at)
- `platform_memberships` (id, user_id, role, created_at)
- `platform_admin_permissions` (id, user_id, capability)
- `audit_logs` (id, actor_user_id, **actor_role**, academy_id nullable, action, entity_type, entity_id, **branch_id nullable**, before jsonb, after jsonb, **context jsonb nullable**, **reason nullable**, **request_id nullable**, **result** enum(success/failure), **failure_reason nullable**, ip, user_agent, created_at)
- `mfa_totp_credentials` (id, user_id, secret_encrypted, verified_at, created_at)
- `mfa_recovery_codes` (id, user_id, code_hash, used_at, created_at)

**3. Pages/routes**
- `/login`, `/logout`, `/forgot-password`, `/reset-password`
- `/mfa/setup` (TOTP enrollment: QR code + verification), `/mfa/challenge` (code entry during login)
- `/account/security` (list active sessions with device/IP/last-active, revoke individual or all-other sessions) — generic, usable by any authenticated user regardless of platform/academy role
- One protected placeholder route to prove the auth+permission gate works end-to-end.

**4. Server actions / API boundaries**
`signIn` (now: password check → if `platform_owner` and MFA not yet enrolled, redirect to forced enrollment; if enrolled, require `challengeMfa` before issuing a session), `signOut`, `requestPasswordReset`, `resetPassword`, `enrollMfa`, `verifyMfaEnrollment`, `challengeMfa`, `regenerateRecoveryCodes`, `listMySessions`, `revokeSession`, `revokeAllOtherSessions`, plus internal helpers: `getAuthContext()`, `hasPermission()`, `recordAudit()`, `checkSuspiciousLogin()`.

**5. Permissions needed**
Role constants defined (`platform_owner`, `platform_admin`, 6 academy roles), exercised via a seeded owner account. MFA enforcement is role-gated: mandatory for `platform_owner`, not required for any other role in this phase.

**6. Security considerations**
- Argon2id (Argon2id cost params tunable via env); shared password Zod schema enforcing **minimum 8 characters, no forced expiry**.
- Session token: 256-bit random value; DB stores only its SHA-256 hash. Cookie flags: `httpOnly`, `secure` (prod), `sameSite=lax`.
- **MFA**: TOTP secret encrypted at rest (app-level encryption key via env, separate from password hashing); recovery codes are single-use, hashed with SHA-256, shown once at generation time only. `platform_owner` sign-in is blocked without a valid TOTP code once enrolled; first login forces enrollment before any platform action is possible.
- **`revokeSession`** must verify the target session belongs to the calling user before revoking — an explicit IDOR-class check with its own test.
- **Suspicious-login detection**: on each successful `signIn`, compare the new session's IP/user-agent against that user's recent session history; if unseen, write an `audit_logs` row (`action = "login.suspicious"`, `result = success`) — actual email/SMS notification delivery is wired in Phase 5 once the notification worker exists; Phase 0 only detects and logs.
- Redis-backed rate limiting on `/login`, `/forgot-password`, and `/mfa/challenge`; generic error messages to avoid user enumeration.
- Session expiry + explicit revocation on logout; revoked/expired sessions rejected server-side on every request.
- Structured logger redacts `password`, `token`, `password_hash`, `secret_encrypted`, `code_hash`, cookie values.
- Secrets via `.env` (never committed).

**7. Dependencies on previous phases**
None — first phase.

**8. How to test**
- Vitest: password hashing round-trip, password-policy rejection (<12 chars), session token generation/validation/expiry, TOTP code generation/validation, recovery-code single-use enforcement, permission-checker logic (including the ungrantable-capability bypass), rate limiter behavior.
- Integration: seed a `platform_owner`, first login forces MFA enrollment, subsequent logins require a valid TOTP code, invalid/reused recovery code rejected; sign out invalidates the session; `/account/security` lists sessions and `revokeSession` on another user's session is rejected (IDOR test); a login from a new IP/user-agent produces an `audit_logs` row with `action = "login.suspicious"`.
- CI: migrations apply cleanly; lint/typecheck/test all green.

**9. Acceptance criteria — Phase 0 is complete when:**
- A seeded `platform_owner` cannot obtain a session without completing TOTP enrollment (first login) and a valid TOTP/recovery code (every login after).
- A password under 12 characters is rejected at signup/reset; there is no forced periodic expiry.
- Session tokens are stored hashed; `/account/security` lists active sessions and can revoke any one of them (never another user's).
- Repeated failed logins are rate-limited; a login from an unseen IP/user-agent produces an `audit_logs` row.
- The permission engine's ungrantable-capability bypass is enforced and unit-tested.
- CI (lint, typecheck, unit tests, migrations) is green on a clean checkout.

---

## Phase 1 — SaaS Core Platform

**1. What we're building**
The platform owner's control plane: academy registration with a full profile field set, an onboarding checklist gating activation, subscription plans (with pricing management restricted to `platform_owner`), academy subscriptions with a state machine including a computed 7-day grace period, manual subscription payment recording (with optional evidence attachment) verification/rejection/reversal, allowance/usage tracking and enforcement, activate/suspend/reactivate/cancel/**close** academy, a subscription renewal action with an expiring-soon view, platform staff with explicit + preset-grouped permission grants, platform financial reporting with revenue breakdowns, platform audit log viewer, and the subscription-status access gate.

**Onboarding, end to end** — the exact sequence `registerAcademy` → subsequent actions produce, tying together pieces defined individually above: (1) create the `academies` row + default `branches` row + owner `users`/`academy_memberships` row, all in one transaction; (2) `createAcademySubscription` assigns a plan, creating the subscription in `Draft`/`Trial`; (3) the platform owner completes/reviews the academy profile (already collected at registration, editable before activation too); (4) `recordSubscriptionPayment`, with evidence, when the plan requires payment before activation; (5) `verifySubscriptionPayment`; (6) `approveAcademy` (sets `approved_by`/`approved_at`); (7) `getOnboardingChecklistStatus` confirms every precondition (profile complete, plan selected, approved, payment verified where required); (8) `activateAcademy` — blocked until step 7 is fully satisfied, transitions the subscription per the table above; (9) an activation notification fires (Phase 5 catalog); (10) `/academy/*` becomes reachable for the owner. Every step from (2) onward is audit-logged. **Academy users cannot self-activate** — every step through `activateAcademy` is `platform_owner`-only; the academy owner account created in step 1 has no onboarding-mutation capability over their own academy's activation.

**2. Database tables**
- `academies` (id, name, slug unique, default_currency, settings jsonb, **type, address, phone, email, website, logo_ref, registration_number, primary_contact_name, primary_contact_phone, created_by, approved_by, approved_at nullable, closed_at nullable**, created_at) — **no `status` column.** Access is determined entirely by `academy_subscriptions.status` (below) plus `closed_at` for permanent closure — intentional, per Decision #1.
- `branches` (id, academy_id, name, code, status, **address, phone**, created_at)
- `academy_memberships` (id, user_id, academy_id, role, status, created_at)
- `subscription_plans` (id, name, description, price_amount_cents, currency, billing_period, max_branches, max_students, max_staff, max_courses, max_storage_bytes, sms_enabled, email_enabled, certificate_enabled, reports_level, is_active, created_at, updated_at)
- `academy_subscriptions` (id, academy_id, plan_id, status, starts_at, ends_at, trial_ends_at, activated_at, suspended_at, cancelled_at, **renewed_at, renewed_by**, created_by, updated_by, notes)
- `subscription_payments` (id, academy_id, subscription_id, amount_cents, currency, payment_method, payment_reference, **evidence_file_ref nullable**, received_at, recorded_by, verified_by, status, notes, created_at)
- `academy_usage` (id, academy_id, active_students_count, active_staff_count, branch_count, course_count, storage_used_bytes, calculated_at)
- `subscription_payment_consumptions` (id, subscription_payment_id **unique**, academy_subscription_id, consumed_at, consumed_by) — the mechanism that makes "a verified payment can only fund one renewal, ever" a hard database guarantee rather than an application-logic promise (see `renewSubscription` rule below)

**3. Pages/routes**
`/platform/dashboard`, `/platform/academies`, `/platform/academies/new`, `/platform/academies/[academyId]` (with onboarding checklist, created-by/approved-by metadata, Activate/Suspend/Reactivate/Cancel/**Close**), `/platform/subscriptions` (with **Renew** action + expiring-soon flags), `/platform/plans`, `/platform/payments` (with evidence upload), `/platform/usage`, `/platform/staff` (with **permission-group presets**), `/platform/reports` (with **revenue breakdowns by month/plan/academy/method**, expected vs. collected revenue), `/platform/audit-logs`, `/platform/settings`. Plus a minimal `/academy/dashboard` shell.

**4. Server actions / API boundaries**
`registerAcademy` (expanded profile fields), `getOnboardingChecklistStatus`, `approveAcademy` (sets `academies.approved_by`/`approved_at` — satisfies one onboarding-checklist precondition; academies have no independent status field to transition; a required-reason rejection reuses the existing `cancelAcademy` action rather than adding a separate `rejectAcademy` — an academy that never gets approved simply stays un-activated or is explicitly cancelled, no new action needed), `createSubscriptionPlan`/`updateSubscriptionPlan`/`setPlanActive` (capability `plans.manage`, **ungrantable — platform_owner only**), `createAcademySubscription`, `renewSubscription` (see full state/date rules in Security considerations below), `recordSubscriptionPayment` (with evidence upload), `verifySubscriptionPayment`, `rejectSubscriptionPayment`, `reverseSubscriptionPayment`, `activateAcademy`, `suspendAcademy`, `reactivateAcademy`, `cancelAcademy`, `closeAcademy` (sets `closed_at`, archive model — academy becomes permanently read-only, never deleted), `checkAllowance(academyId, resource)`, `recalculateUsage`, `createPlatformAdminAccount`/`grantPlatformPermission`/`revokePlatformPermission` (capability `platform.staff.manage`, **ungrantable — platform_owner only**; UI-only permission-group presets are a convenience layer on top, not a separate mechanism), `queryAuditLogs`, `getPlatformReports` (with breakdown params).

**5. Permissions needed**
`platform_owner`: full access, including every ungrantable capability. `platform_admin`: denied by default; each action checked against `platform_admin_permissions`. The following are never satisfiable regardless of grants (Planning Gaps Resolution §1): `plans.manage`, `platform.revenue.view`, `platform.staff.manage`, and every academy-lifecycle/payment-verification action — `approveAcademy`, `activateAcademy`, `suspendAcademy`, `reactivateAcademy`, `cancelAcademy`, `closeAcademy`, `renewSubscription`, `verifySubscriptionPayment`, `rejectSubscriptionPayment`, `reverseSubscriptionPayment` — a `platform_admin` can never create or manage other platform staff accounts, can never grant, revoke, or otherwise manage anyone's platform permissions (their own included), and can never move an academy or a subscription payment through any lifecycle transition. The only grantable capabilities in this phase are: `recordSubscriptionPayment` (data entry only, not verification), `queryAuditLogs`, and read access to `getPlatformReports`' non-revenue views. `academy_owner`: read-only view of own academy profile + subscription status/dates.

**6. Security considerations**
- **Subscription state machine — exact transition table.** Every transition is one of these; anything not listed is rejected server-side regardless of what the UI sends. There is **no "automation" actor anywhere** — every human-triggered transition is `platform_owner`-only, consistent with the report's core "no automatic activation" business rule; the only non-human-triggered entry is the lazy, computed Past-Due→Suspended flip (not a scheduled job — see below).

  | From | To | Trigger | Actor |
  |---|---|---|---|
  | `Draft` | `Trial` | Plan assigned, trial period starts | `platform_owner` (via `createAcademySubscription`) |
  | `Draft` | `Active` | Plan assigned with no trial + `activateAcademy` | `platform_owner` |
  | `Trial` | `Active` | `activateAcademy` (checklist satisfied) | `platform_owner` |
  | `Trial` | `Expired` | `trial_ends_at` passes without activation | computed at access-check time (lazy, no job) |
  | `Trial` | `Cancelled` | Administrative cancellation | `platform_owner` |
  | `Active` | `Past Due` | `ends_at` passes without a renewal | computed at access-check time (lazy, no job) |
  | `Past Due` | `Active` | `renewSubscription` (verified payment) | `platform_owner` |
  | `Past Due` | `Suspended` | 7-day grace period elapses | computed at access-check time (lazy, no job) |
  | `Suspended` | `Active` | `renewSubscription` (verified payment) — reactivates in the same call | `platform_owner` |
  | `Expired` | `Active` | `renewSubscription` (verified payment) | `platform_owner` |
  | any of `Active`/`Trial`/`Past Due`/`Suspended`/`Expired` | `Cancelled` | Administrative cancellation | `platform_owner` |
  | `Cancelled` | *(none)* | **Terminal.** Resuming service requires a **new** `academy_subscriptions` row via `createAcademySubscription`, never a transition out of `Cancelled` | — |
  | any state | *(academy `closed_at` set)* | `closeAcademy` | `platform_owner` — **permanent**, overrides every subscription state, independent of this table |

  `Past Due` is the 7-day grace period, computed at access-check time — there is **no background/scheduled job** anywhere in this state machine. Past 7 days, the gate treats access as `Suspended` immediately (computed, not stored), and the stored `status` value is lazily flipped to `Suspended` the next time that subscription row is read or written by any action. Every transition writes an audit row (before/after `status`, actor, and — for administrative actions — the required `reason`); an invalid transition attempt is rejected before any write and is itself audited as a failed attempt if security-relevant (e.g. a non-owner attempting `activateAcademy` directly).
- `closeAcademy` is a **one-way, permanent** action distinct from cancellation: sets `closed_at`, blocks all further writes academy-wide, but the academy and every record under it (including for certificate verification) remains queryable read-only forever — **never deleted, never anonymized**. Closure requires a reason (stored on the audit row) and is itself audited. All of that academy's active sessions are revoked and its academy-console logins are blocked at the next auth check; every `/academy/*` route becomes inaccessible to academy users. `platform_owner` retains full read access to the closed academy's `/platform/academies/[id]` detail (closure never removes it from the platform owner's own view — only the academy's own console is blocked). Closed-academy files remain in storage and continue to count toward that academy's (now permanently frozen) usage figure — this has no practical effect since no further uploads are possible once closed, but the figure is never zeroed out or excluded from platform-wide storage accounting. Ordinary UI actions provide no path back from `closed_at` — there is no "Reopen" action anywhere in this plan.
- `checkAllowance` runs server-side inside every capped-resource create action from this phase onward — a client-side "limit remaining" display is informational only, never trusted for the actual gate. Downgrading a plan is rejected server-side if current usage exceeds the target plan's limits.
- Every subscription/payment mutation re-verifies `subscription_id`/`academy_id` linkage server-side.
- **`renewSubscription` — exact rule.** Valid **only** from `Active`, `Past Due`, `Suspended`, or `Expired`. Rejected outright from `Draft`, `Trial` (those convert via `activateAcademy`, not renewal), or `Cancelled` (a cancelled subscription is final — resuming service means creating a **new** subscription via `createAcademySubscription`, not renewing the old one). A **hard precondition** for every call regardless of source state: there must be at least one `subscription_payments` row with `status = Verified` for this subscription that hasn't already been consumed by a prior renewal — no verified payment, no renewal, full stop (this mirrors the same manual-payment-gates-access principle that governs initial activation). **This is enforced as a real transaction, not just an application check**, to close the race condition where two concurrent renewal attempts could both try to spend the same payment: (1) open a DB transaction and lock the candidate `subscription_payments` row (`SELECT ... FOR UPDATE`); (2) verify it is `status = Verified` and not reversed; (3) verify no `subscription_payment_consumptions` row already references it (the table's unique constraint on `subscription_payment_id` makes a double-spend impossible even under a race — the second concurrent transaction's insert simply fails); (4) insert the consumption row (`subscription_payment_id`, `academy_subscription_id`, `consumed_at`, `consumed_by`); (5) update `academy_subscriptions.ends_at`/`renewed_at`/`renewed_by`/`status`; (6) write the audit row; (7) commit atomically — any failure at any step rolls back the entire transaction, so a renewal never half-applies (dates moved but no consumption recorded, or vice versa). A reversed `subscription_payments` row can never be consumed (checked in step 2), and a payment already consumed by a prior renewal is rejected in step 3 with a clear error rather than silently succeeding twice. Effect on dates: `starts_at` is **never** changed by renewal; `ends_at` becomes `max(current ends_at, now) + plan.billing_period` — renewing before expiry extends from the current end date (no lost paid time), renewing after a lapse extends from today (no retroactive free days for the lapsed period); `renewed_at`/`renewed_by` are stamped on every call. Effect on status: if the source state is `Past Due`, `Suspended`, or `Expired`, `renewSubscription` **also reactivates in the same call** — it sets `status = Active` itself; there is no separate manual "reactivate" click required after a renewal (reactivation is folded into renewal, not a second step). If the source state is already `Active`, status is simply left as `Active` (renewal is a no-op on status, only `ends_at` moves). Every renewal is audit-logged with before/after `status` and `ends_at`, plus the verified payment reference it relied on.
- **No online payment path exists at all.**
- Payments are append-only with a status field; evidence files go through the same private-storage/tenant-scoped-download pattern used for student/staff documents (Phase 2).
- A subscription-status gate runs on every `/academy/*` request: blocked if not `Active`/`Trial`/`Past Due`-within-grace, or if `closed_at` is set (closure always blocks regardless of subscription status).
- Every activation/suspension/closure/payment/plan/renewal change is audit-logged with before/after state.
- `academies.slug` uniqueness enforced by DB constraint.

**7. Dependencies on previous phases**
Phase 0 (auth, MFA, session, permission engine, audit log utility, rate limiting).

**8. How to test**
- Unit: subscription state machine — every transition in the table above accepted, every unlisted transition rejected, including the 7-day grace-period computation and the `Trial → Expired` lazy flip, usage calculation, `checkAllowance` block behavior per resource type, downgrade-rejection logic, plan CRUD validation, ungrantable-capability enforcement (a `platform_admin` granted every other capability still cannot call `createSubscriptionPlan`, `getPlatformReports`' revenue view, `approveAcademy`, `activateAcademy`, `suspendAcademy`, `reactivateAcademy`, `cancelAcademy`, `closeAcademy`, `renewSubscription`, `verifySubscriptionPayment`, `rejectSubscriptionPayment`, or `reverseSubscriptionPayment` — only `recordSubscriptionPayment`, `queryAuditLogs`, and non-revenue reports remain grantable); `renewSubscription` per source state — rejected from `Draft`/`Trial`/`Cancelled`, rejected from `Active`/`Past Due`/`Suspended`/`Expired` without a verified payment, `ends_at` anchoring (`max(current ends_at, now) + billing_period`) correct for both an early (pre-expiry) and a late (post-lapse) renewal, `starts_at` untouched in all cases, and `Past Due`/`Suspended`/`Expired` sources flip to `Active` in the same call with no separate reactivation step.
- Integration: register academy with full profile → academy+branch+owner created; `activateAcademy` blocked until the onboarding checklist is satisfied; record payment with evidence → verify → activate subscription → `/academy/dashboard` reachable; suspend → academy routes blocked; `Past Due` for 8 days → access behaves as suspended; `closeAcademy` → academy permanently read-only, its certificates still verify via the Phase 5 public endpoint; `renewSubscription` extends `ends_at` and appears on `/platform/subscriptions` as no-longer-expiring; creating a branch/staff/student past the plan limit is rejected with a clear error; downgrading a plan while over its limits is rejected; every action above produces a matching audit-log row; and, confirming Decision #1, no code path anywhere reads or writes an `academies.status` field for access decisions — access is derived solely from `academy_subscriptions.status` plus `closed_at`. **Concurrency**: firing two `renewSubscription` calls at the same verified payment simultaneously (e.g. two browser tabs, or a retry racing the original request) results in exactly one succeeding and the other rejected with a clear "already consumed" error — never two renewals, never a corrupted half-applied state; a reversed payment can never be consumed by a renewal, tested directly.

**9. Acceptance criteria — Phase 1 is complete when:**
- A platform owner can register an academy with a full profile, assign a plan, record and verify a manual payment, and `activateAcademy` succeeds only once every onboarding-checklist item is satisfied.
- Academy access is derived solely from `academy_subscriptions.status` plus `closed_at` — no `academies.status` field exists or is read anywhere.
- Every transition in the Phase 1 state-transition table works exactly as specified; every unlisted transition is rejected server-side.
- A verified subscription payment funds exactly one renewal, including under a concurrent double-submit.
- `checkAllowance` blocks branch/staff/student/course/storage creation past plan limits and blocks any downgrade that would leave the academy over its new plan's limits.
- `closeAcademy` permanently blocks the academy's own console while the platform owner retains full read access to its data.
- Every action above writes a matching `audit_logs` row in the same transaction as the mutation.
- `plans.manage`, `platform.revenue.view`, `platform.staff.manage`, and every academy-lifecycle/payment-verification action (`approveAcademy` through `reverseSubscriptionPayment`, per §5 above) are unsatisfiable for any `platform_admin`, tested directly.

---

## Phase 2 — Academy Operations

**1. What we're building**
Academy settings (direct-edit, no approval) with the full profile field set, own-academy usage visibility, full branch CRUD, staff profiles with role/branch assignment, student registration/admissions with unique student IDs, student ID card issuance/reprint, and the academy-scoped audit log view.

**2. Database tables**

- `staff_profiles` (id PK, `academy_id` FK academies NOT NULL, `user_id` FK users NOT NULL, employee_number text nullable, full_name text NOT NULL, phone text NOT NULL, email text nullable, hire_date date nullable, status enum(`active`,`archived`) NOT NULL default `active`, created_at, updated_at; unique `(academy_id, user_id)`; index `(academy_id)`)
- `staff_branch_assignments` (id PK, `academy_id` FK NOT NULL, `staff_profile_id` FK staff_profiles NOT NULL, `branch_id` FK branches NOT NULL, created_at; unique `(staff_profile_id, branch_id)`)
- `staff_documents` (id PK, `academy_id` FK NOT NULL, `staff_profile_id` FK staff_profiles NOT NULL, document_type enum(`id_copy`,`certificate`,`contract`,`other`) NOT NULL, file_ref text NOT NULL, uploaded_by FK users NOT NULL, status enum(`active`,`archived`) NOT NULL default `active`, created_at; index `(staff_profile_id)`)
- `students` (id PK, `academy_id` FK NOT NULL, `branch_id` FK branches NOT NULL, student_number text NOT NULL, full_name text NOT NULL, date_of_birth date nullable, gender text nullable, phone text nullable, email text nullable, guardian_name text nullable, guardian_phone text nullable, status enum(`active`,`archived`) NOT NULL default `active`, created_by FK users NOT NULL, created_at, updated_at; unique `(academy_id, student_number)`; index `(academy_id)`, `(branch_id)`)
- `student_documents` (id PK, `academy_id` FK NOT NULL, `student_id` FK students NOT NULL, document_type enum(`id_copy`,`certificate`,`other`) NOT NULL, file_ref text NOT NULL, uploaded_by FK users NOT NULL, status enum(`active`,`archived`) NOT NULL default `active`, created_at; index `(student_id)`)
- `student_id_cards` (id PK, `academy_id` FK NOT NULL, `student_id` FK students NOT NULL, card_number text NOT NULL, photo_file_ref text nullable, issued_at timestamp NOT NULL, issued_by FK users NOT NULL, reprint_count integer NOT NULL default 0, status enum(`active`,`archived`) NOT NULL default `active`, created_at; unique `card_number`; index `(student_id)`)

All tables above: no hard delete — `status = archived` is the only removal path (Planning Gaps Resolution §12), and archiving frees the entity's allowance slot (branches/staff/students) per the Archive & Deactivation Rules table below.

**3. Pages/routes**
`/academy/settings` (expanded profile fields + own-academy usage widget), `/academy/branches`, `/academy/staff`, `/academy/staff/new`, `/academy/students`, `/academy/students/new`, `/academy/admissions`, `/academy/id-cards`, **`/academy/audit-logs`** (Owner/Admin only).

**4. Server actions / API boundaries**
`updateAcademySettings` (expanded fields, direct edit — no approval step), `getOwnAcademyUsage`, `createBranch`/`updateBranch`/`archiveBranch` (each create call goes through `checkAllowance`), `createStaff`/`updateStaff` (`checkAllowance`), `assignStaffRole`, `assignStaffBranches`, `uploadStaffDocument` (`checkAllowance('storage')`), `registerStudent` (`checkAllowance`), `updateStudent`, `searchStudents`, `uploadStudentDocument` (`checkAllowance('storage')`), `generateStudentId`, `issueStudentIdCard` (`checkAllowance('storage')` for the photo), `reprintStudentIdCard`, `queryAuditLogs` (reused from Phase 1, scoped to the caller's `academy_id`).

**5. Permissions needed** (per report §22)
Unchanged from the original matrix (Branches/Staff/Students/ID cards role table). `/academy/audit-logs`: Owner and Admin only.

**6. Security considerations**
- Every list/detail query filtered by `academy_id`, further by `branch_id` for **branch-limited roles (Admissions Officer, Trainer)** — **academy-wide roles (Academy Owner, Academy Administrator, Manager, Finance Officer)** skip the branch filter by design, not by accident. Admissions Officer is branch-limited specifically because admissions/registration work is inherently tied to the branch a student is walking into — an Admissions Officer's student, admissions, and ID-card views are scoped to their assigned branch(es) only, the same mechanism already defined for Trainer.
- `(academy_id, student_number)` uniqueness is a DB-level unique constraint.
- `checkAllowance` blocks branch/staff/student creation past plan limits — tested explicitly at this phase since these are the first capped-resource actions built.
- Document/photo uploads validated, checked against the academy's storage allowance via `checkAllowance('storage')` (hard block, same as every other capped resource), and stored privately; only retrievable through authorized, tenant-scoped downloads.
- IDOR check: branch-limited staff hitting another branch's record directly gets 403/404.
- `/academy/audit-logs` query is hard-scoped to the caller's own `academy_id` — never accepts a client-supplied academy filter.
- List endpoints paginated from this phase onward.

**7. Dependencies on previous phases**
Phase 0 + Phase 1 (`academies`, `branches`, the active-subscription gate, `checkAllowance`, `academy_usage`, `queryAuditLogs`).

**8. How to test**
- Unit: student ID generation/uniqueness, branch-assignment many-to-many, permission matrix table-driven tests.
- Integration: two academies both register `STD-000001` successfully; duplicate within one academy rejected; staff assigned to 2 of 3 branches sees only those branches; IDOR attempt blocked; ID card issue/reprint recorded; creating a 101st student on a 100-student plan is rejected with a clear allowance-limit message; `/academy/audit-logs` for Academy A never returns Academy B's rows even if IDs are guessed; a Trainer hitting `/academy/audit-logs` gets a permission-denied response.

**9. Acceptance criteria — Phase 2 is complete when:**
- An active academy can create branches, staff, and students up to its plan's allowance; the next creation past each limit is rejected with a specific, clear message.
- Student IDs are unique within an academy and independent across academies (two academies can both use `STD-000001`).
- Admissions Officer and Trainer — the branch-limited roles — never see or can act on another branch's students, staff, or ID cards, including via a guessed URL.
- `/academy/audit-logs` is reachable only by Academy Owner/Admin and is hard-scoped to the caller's own academy.
- File uploads (documents, ID-card photos) are validated, count against the storage allowance, and are only downloadable through an authorized, tenant-scoped path.

---

## Phase 3 — Training Operations

**1. What we're building**
Programs/courses/batches (course creation now allowance-checked), trainer-to-batch assignment, timetable (no attendance), exam setup/mark entry, configurable grade bands with approval, and the exam-result review/approve/publish workflow with immutable published results and an auditable correction path.

**2. Database tables**

- `programs` (id PK, `academy_id` FK NOT NULL, name text NOT NULL, description text nullable, status enum(`active`,`archived`) NOT NULL default `active`, created_at, updated_at; unique `(academy_id, name)`)
- `courses` (id PK, `academy_id` FK NOT NULL, `program_id` FK programs NOT NULL, name text NOT NULL, code text nullable, description text nullable, duration_weeks integer nullable, status enum(`active`,`archived`) NOT NULL default `active`, created_at, updated_at; unique `(academy_id, name)`; index `(program_id)`)
- `batches` (id PK, `academy_id` FK NOT NULL, `branch_id` FK branches NOT NULL, `course_id` FK courses NOT NULL, name text NOT NULL, code text NOT NULL, start_date date NOT NULL, end_date date nullable, status enum(`planned`,`active`,`completed`,`archived`) NOT NULL default `planned`, created_at, updated_at; unique `(academy_id, code)`; index `(course_id)`, `(branch_id)`)
- `batch_enrollments` (id PK, `academy_id` FK NOT NULL, `batch_id` FK batches NOT NULL, `student_id` FK students NOT NULL, enrolled_at timestamp NOT NULL, status enum(`active`,`withdrawn`,`completed`) NOT NULL default `active`, created_at; unique `(student_id, batch_id)` for active enrollment, per Database Constraints & Indexes; index `(academy_id, student_id)`)
- `batch_trainer_assignments` (id PK, `academy_id` FK NOT NULL, `batch_id` FK batches NOT NULL, `staff_profile_id` FK staff_profiles NOT NULL, assigned_at timestamp NOT NULL, status enum(`active`,`removed`) NOT NULL default `active`, created_at; unique `(batch_id, staff_profile_id)`)
- `timetables` (id PK, `academy_id` FK NOT NULL, `branch_id` FK branches NOT NULL, `batch_id` FK batches NOT NULL, day_of_week enum(`mon`..`sun`) NOT NULL, start_time time NOT NULL, end_time time NOT NULL, room text nullable, trainer_staff_profile_id FK staff_profiles nullable, created_at, updated_at; check `end_time > start_time`; no attendance/check-in column exists on this table or anywhere else — Decision #21)
- `grade_configurations` (id PK, `academy_id` FK NOT NULL, name text NOT NULL, status enum(`draft`,`pending_approval`,`approved`,`active`,`retired`) NOT NULL default `draft`, created_by FK users NOT NULL, approved_by FK users nullable, approved_at timestamp nullable, activated_at timestamp nullable, retired_at timestamp nullable, created_at, updated_at; index `(academy_id, status)`)
- `grade_bands` (id PK, `grade_configuration_id` FK grade_configurations NOT NULL, label text NOT NULL, min_mark numeric NOT NULL, max_mark numeric NOT NULL, is_pass boolean NOT NULL, created_at; check `max_mark >= min_mark`; exclusion constraint via `btree_gist` on `(grade_configuration_id, numrange(min_mark, max_mark))` — mandatory on every configuration regardless of status, not just `active` ones, per Planning Gaps Resolution §5)
- `exams` (id PK, `academy_id` FK NOT NULL, `batch_id` FK batches NOT NULL, name text NOT NULL, max_marks numeric NOT NULL, exam_date date nullable, status enum(`scheduled`,`marks_entry`,`completed`,`archived`) NOT NULL default `scheduled`, created_at, updated_at; index `(batch_id)`)
- `exam_results` (id PK, `academy_id` FK NOT NULL, `exam_id` FK exams NOT NULL, `student_id` FK students NOT NULL, `batch_id` FK batches NOT NULL — denormalized, required for the Phase 5 certificate-eligibility query — marks_obtained numeric nullable, `grade_configuration_id` FK grade_configurations NOT NULL (snapshotted at publish time, never updated after), grade_band_label text nullable (snapshotted), pass_fail enum(`pending`,`pass`,`fail`) NOT NULL default `pending`, status enum(`draft`,`marks_entered`,`submitted`,`under_review`,`approved`,`rejected`,`published`) NOT NULL default `draft`, entered_by FK users NOT NULL, submitted_at timestamp nullable, approved_by FK users nullable, approved_at timestamp nullable, published_at timestamp nullable, created_at, updated_at; unique `(exam_id, student_id)`; index `(academy_id, batch_id)`, `(student_id)`)
- `result_corrections` (id PK, `academy_id` FK NOT NULL, `original_result_id` FK exam_results NOT NULL, requested_by FK users NOT NULL, reason text NOT NULL, proposed_marks_obtained numeric nullable, status enum(`requested`,`approved`,`rejected`,`applied`) NOT NULL default `requested`, decided_by FK users nullable, decided_at timestamp nullable, applied_at timestamp nullable, created_at; index `(original_result_id)`)
- `approval_requests` (id PK, `academy_id` FK NOT NULL, entity_type enum(`result`,`grade_configuration`,`expense`,`student_payment`) NOT NULL, `entity_id` uuid NOT NULL, requested_by FK users NOT NULL, status enum(`pending`,`approved`,`rejected`) NOT NULL default `pending`, reason text nullable, decided_by FK users nullable, decided_at timestamp nullable, created_at; index `(entity_type, entity_id)`, `(academy_id, status)`)

All tables above: `status = archived` (or the entity's terminal state, e.g. `retired`/`completed`/`withdrawn`) is the only removal path — no hard delete anywhere in this phase, per Archive & Deactivation Rules below.

**3. Pages/routes**
`/academy/programs`, `/academy/courses`, `/academy/batches`, `/academy/timetable`, `/academy/exams`, `/academy/grades`, `/academy/results`.

**4. Server actions / API boundaries**
`createProgram`, `createCourse` (`checkAllowance('courses')`), `createBatch`, `assignTrainerToBatch`, `enrollStudentInBatch`, `createTimetableEntry`, `createExam`, `enterMarks`, `submitResults`, `approveResult`/`rejectResult`, `publishResults`, `requestResultCorrection`, `createGradeConfiguration`, `updateGradeBands`, `submitGradeConfigForApproval`, `approveGradeConfig`.

**5. Permissions needed**
Unchanged from original matrix (Courses/batches, Exams, Grade bands, Result approval).

**6. Security considerations**
Unchanged from original design (grade-band exclusion constraint, grade-config approval gating, published-results immutability with `requestResultCorrection` as the only correction path, `grade_configuration_id` snapshotting, trainer batch-scoping) — plus `checkAllowance('courses')` enforced server-side on `createCourse`.

**7. Dependencies on previous phases**
Phase 0–2.

**8. How to test**
Unchanged from original design, plus: creating a course past the plan's course limit is rejected.

**9. Acceptance criteria — Phase 3 is complete when:**
- Courses can be created up to the plan's course allowance and are rejected beyond it.
- Grade bands never overlap (enforced at the DB level) and a changed configuration only takes effect after Manager/Admin approval.
- A trainer can enter marks only for batches they are explicitly assigned to.
- A published result cannot be edited directly under any code path — only `requestResultCorrection` can change it, and every correction is audited with before/after values.
- A published result retains the grade-band configuration that was active at the moment it was published, even if the bands are edited afterward.
- No attendance concept exists anywhere in the schema, routes, or UI for this phase.

---

## Phase 4 — Finance

**1. What we're building**
Student charges, manual payment recording, receipts, income/expense records, the approval workflow, and reversal/adjustment records. No structural changes from the original design — the gap analysis confirmed the platform-subscription vs. academy-finance separation is already architecturally sound (`REQUIREMENTS_GAP_ANALYSIS.md` §2/§14).

**2. Database tables**

- `student_charges` (id PK, `academy_id` FK NOT NULL, `student_id` FK students NOT NULL, description text NOT NULL, amount_cents integer NOT NULL, currency text NOT NULL default academy's `default_currency`, due_date date nullable, status enum(`open`,`partially_paid`,`paid`,`cancelled`) NOT NULL default `open`, created_by FK users NOT NULL, created_at, updated_at; check `amount_cents >= 0`; index `(student_id)`)
- `student_payments` (id PK, `academy_id` FK NOT NULL, `student_id` FK students NOT NULL, `charge_id` FK student_charges nullable, amount_cents integer NOT NULL, currency text NOT NULL, method enum(`cash`,`mobile_money`,`bank_transfer`) NOT NULL, reference text nullable, received_at timestamp NOT NULL, recorded_by FK users NOT NULL, status enum(`pending_approval`,`approved`,`rejected`,`reversed`) NOT NULL default `pending_approval`, approved_by FK users nullable, approved_at timestamp nullable, `reversed_payment_id` self-FK nullable, reversal_reason text nullable, created_at; check `amount_cents >= 0`; index `(academy_id, created_at)`, `(student_id)`)
- `receipts` (id PK, `academy_id` FK NOT NULL, `student_payment_id` FK student_payments NOT NULL, receipt_number text NOT NULL, issued_at timestamp NOT NULL, issued_by FK users NOT NULL, created_at; unique `student_payment_id`; unique `(academy_id, receipt_number)`)
- `income_records` (id PK, `academy_id` FK NOT NULL, `branch_id` FK branches nullable, category text NOT NULL, description text nullable, amount_cents integer NOT NULL, currency text NOT NULL, recorded_by FK users NOT NULL, status enum(`posted`,`reversed`) NOT NULL default `posted`, `reversed_record_id` self-FK nullable, created_at; check `amount_cents >= 0`)
- `expense_records` (id PK, `academy_id` FK NOT NULL, `branch_id` FK branches nullable, category text NOT NULL, description text nullable, amount_cents integer NOT NULL, currency text NOT NULL, submitted_by FK users NOT NULL, status enum(`draft`,`pending_approval`,`approved`,`rejected`,`reversed`) NOT NULL default `draft`, approved_by FK users nullable, approved_at timestamp nullable, rejection_reason text nullable, `reversed_record_id` self-FK nullable, created_at, updated_at; check `amount_cents >= 0`)
- `approval_requests` (reused from Phase 3, `entity_type` gains `student_payment`/`expense` rows here).

No posted financial record (`student_payments`, `income_records`, `expense_records` once `approved`/`posted`) is ever deleted under any code path, for any of these five entities — reversal only, producing a new linked row with the original untouched (Planning Gaps Resolution §6).

**3. Pages/routes**
`/academy/finance`, `/academy/finance/approvals`.

**4. Server actions / API boundaries**
Unchanged: `createStudentCharge`, `recordStudentPayment`, `issueReceipt`, `createIncomeRecord`, `createExpenseRecord`, `submitExpenseForApproval`, `approveExpense`/`rejectExpense`, `approveStudentPayment`, `reverseTransaction`/`adjustTransaction`, `getFinanceReports`.

**5. Permissions needed**
Unchanged from original matrix.

**6. Security considerations**
Unchanged (self-approval blocked server-side, integer-cents money, no delete path — reversal only, receipt numbering unique per academy).

**7. Dependencies on previous phases**
Phase 0–3.

**8. How to test**
Unchanged, **plus a new explicit test**: `getFinanceReports`/academy income-expense views never include `subscription_payments` rows, confirming the platform/academy finance separation holds at the query level, not just by table design.

**9. Acceptance criteria — Phase 4 is complete when:**
- Manual student payments (cash/mobile money/bank transfer) can be recorded, and — where approval is required per the permission matrix — the person who recorded a payment can never be the one who approves it.
- No posted financial record (payment, expense, income) is ever hard-deleted; corrections only ever produce a new linked reversal/adjustment row, with the original untouched.
- Academy finance reports and income/expense views never include a `subscription_payments` row.
- Every finance mutation is audited with before/after amounts and both actor and approver identities.

---

## Phase 5 — Credentials & Release

**1. What we're building**
Certificates with public verification (unaffected by academy closure — closed academies stay verifiable per the archive-model decision), the **full notification event catalog** with fixed code-defined templates, **data export** (CSV) across Reports/Student list/Finance/Audit logs, finalized reports, **operational monitoring/alerting**, a systematic security re-audit, full Playwright coverage, a backup/restore drill, and the production release checklist.

**2. Database tables**

- `certificates` (id PK, `academy_id` FK NOT NULL, `student_id` FK students NOT NULL, **`batch_id` FK batches NOT NULL** — a certificate is issued for a specific batch/course, not just "the academy," so eligibility can be checked against that batch's results — certificate_code text NOT NULL, issued_at timestamp NOT NULL, issued_by FK users NOT NULL, status enum(`issued`,`cancelled`) NOT NULL default `issued`, cancelled_at timestamp nullable, cancelled_by FK users nullable, cancellation_reason text nullable, created_at; unique `certificate_code`; **unique `(student_id, batch_id)`** — at most one certificate per completed batch, DB-enforced (Planning Gaps Resolution §7/§15); index `(academy_id, student_id)`)
- `certificate_verifications` (id PK, `certificate_id` FK certificates NOT NULL, verified_at timestamp NOT NULL, ip text NOT NULL, user_agent text nullable, created_at; index `(certificate_id, verified_at)`)
- `notifications` (id PK, `academy_id` FK nullable — platform-level events have no academy — `user_id` FK users nullable (recipient), event_type text NOT NULL, channel enum(`email`,`sms`,`in_app`) NOT NULL, template_id text NOT NULL, payload jsonb nullable (redacted per the same rule as `audit_logs`), status enum(`pending`,`sent`,`failed`) NOT NULL default `pending`, attempt_count integer NOT NULL default 0, idempotency_key text NOT NULL, last_error text nullable, sent_at timestamp nullable, created_at; unique `(idempotency_key, channel)`; index `(status, created_at)` for the worker's retry scan — already listed in Database Constraints & Indexes)

Certificates are never issued with a `Draft`/`Generated`/`Reissued`/`Expired` state — see the Certificate Lifecycle table below (Planning Gaps Resolution §7).

**3. Pages/routes**
`/academy/certificates`, `/academy/reports` (finalized, with export actions), `/academy/notifications` (delivery-status view + **notification-preference toggles** for optional event types), `/platform/reports` (finalized, with export actions), `/platform/settings`, `/verify/[certificateCode]` (public — works for closed academies too).

**4. Server actions / API boundaries**
`issueCertificate` (requires `batchId` + the eligibility check below), `cancelCertificate`, `verifyCertificate`, `enqueueNotification` (now called from every event trigger point established in Phases 1–4: academy onboarding/activation/suspension/expiry-reminder/renewal, result approvals/publish, payment approvals/receipts, certificate issue/cancel, and the Phase 0 suspicious-login flag), the BullMQ notification worker (`sendEmail`/`sendSms`, fixed templates per event), `exportData(entityType, filters, format)` (permission- and tenant/branch-scoped identically to the underlying list query, audit-logged on every call), `generateReport`.

**5. Permissions needed**
Certificates: unchanged matrix. `/verify/[code]`: public, minimal fields, rate-limited. `exportData`: available on Reports/Student list/Finance/Audit logs to whichever roles can already view that underlying data — export never grants access beyond what the role's existing view permission allows.

**6. Security considerations**
- Certificate codes opaque/non-sequential; verification rate-limited and logged; **works unchanged for closed/archived academies** since closure never deletes data. `cancelCertificate` never deletes the row or removes it from `/verify/[certificateCode]` — a cancelled certificate stays permanently verifiable, just with a "cancelled/invalid" status instead of "valid"; the verification endpoint's only "not found" case is a genuinely nonexistent code, never a cancelled one.
- **Certificate eligibility — uses only existing result/grade mechanisms, nothing new.** `issueCertificate(studentId, batchId)` is server-side blocked unless the given student has at least one `exam_results` row for that `batch_id` with `status = published` **and** a `Pass` outcome under the `grade_bands` active at the time that result was published (the same `grade_configuration_id` snapshot already stored on the result, per Phase 3). No new grading concept, threshold, or attendance-style criterion is introduced — eligibility is exactly "a published, passing result exists for this student in this batch," which is the only academic-completion signal this plan defines anywhere. If an academy runs multiple exams per batch, any one published Pass result in that batch satisfies eligibility (the plan does not define a "final exam" concept distinct from other exams, so it cannot require one specifically). Attempting to issue against a batch with no qualifying result is rejected with a clear error naming the missing precondition.
- Notification payloads redacted in logs; the full event catalog (onboarding, activation, suspension, expiry, renewal, approvals, receipts, results, certificates, security/suspicious-login) uses fixed, code-maintained English templates — no admin-editable template UI for MVP.
- **Channels and priority** (Planning Gaps Resolution §10): email is always attempted; SMS is attempted only if the academy's plan has `sms_enabled`; an in-app `notifications` row is always created regardless of email/SMS outcome. Email and SMS are independent attempts, not a fallback chain — a failed email never triggers an SMS send it wasn't already going to make.
- **Background jobs (BullMQ) are idempotent.** Every job's idempotency key is `(event_type, entity_id)` (e.g. `("result.published", exam_result_id)`) — retrying or duplicate-enqueuing the same event never sends a duplicate notification; the worker checks the `notifications` row for that key before sending. **Retry policy**: 5 attempts, exponential backoff (1m, 5m, 15m, 1h, 6h), then marked `failed` (visible in `/academy/notifications`' delivery-status view and to platform monitoring, not silently dropped) rather than retried forever. Provider timeouts and rate-limit responses are treated as a retryable failure through this same backoff — no separate hand-rolled policy. Opt-out is limited to event types already marked "optional" in `DESIGN.md` §9.8; mandatory events (suspension, security alerts) render as a disabled always-on toggle, never a real opt-out.
- `exportData` must return exactly the same row set the equivalent on-screen list would for that caller's role/tenant/branch scope — never a bypass of row-level access control — and every export call is audit-logged (`action = "data.export"`).
- **Operational monitoring**: Sentry-class error tracking extended to BullMQ queue health, storage/email/SMS provider health, with alert thresholds for repeated failures; no bespoke in-app incident-tracking feature (kept external, per the original report's tool recommendation and to avoid scope creep toward excluded CRM/ticketing territory).
- Systematic re-audit of every server action from Phases 1–4 **plus every new action from this revision** (MFA, session revocation, `checkAllowance`, `closeAcademy`, `exportData`, permission-group presets) against: Zod schema present, `hasPermission()` check present, tenant/branch scoping present, audit logging present where sensitive.
- `npm audit`/dependency scanning.
- Backup taken and restored against a seeded database; specific frequency/RPO/RTO numbers are explicitly deferred to when a deployment/hosting target is chosen (noted as an open item, not blocking this phase's drill).
- Session cookie `Secure` flag confirmed once a deployment target is chosen.

**7. Dependencies on previous phases**
All prior phases.

**8. How to test**
- Unit: certificate code generation/uniqueness, **certificate eligibility (issuance rejected with no published-Pass result in the batch, accepted with one)**, verification-lookup projection, notification job creation/retry per event type, `exportData` row-set equivalence to the underlying list query per role.
- Integration: issue → verify → cancel → verify (cancelled) → **close the issuing academy → verify still succeeds**; each catalog event fires its notification end-to-end through the worker; an academy owner exports the student list and the export contains exactly their academy's (and, if branch-limited, their branch's) students, nothing more; a Trainer attempting `exportData` on Finance is denied.
- Full Playwright run across the whole product (sign-in with MFA for the platform owner → register/activate an academy → set up branch/staff/student, respecting allowance limits → batch/exam/publish → finance approval → certificate issue/verify → close a second "control" academy and confirm its certificates still verify) with zero cross-tenant leakage asserted throughout.
- `npm audit` reviewed; backup+restore drill executed and documented.

**9. Acceptance criteria — Phase 5 is complete when:**
- A certificate can be issued only when the target student has a published, passing result in the referenced batch; cancelling a certificate leaves it permanently, publicly verifiable as cancelled — including for a closed academy.
- The full notification event catalog fires end-to-end through the BullMQ worker; retrying or duplicate-enqueuing an event never produces a duplicate critical notification (idempotency key enforced).
- `exportData` never returns more than the caller's role/tenant/branch scope could already see on-screen, and every export call is audited.
- The full Playwright suite passes with zero cross-tenant leakage across a two-academy scenario; `npm audit` is clean or documented; a backup+restore drill against a seeded database succeeds.
- The Phase 5 systematic security re-audit (Zod/permission/tenant-scope/audit-log checklist) has been run against every action from every prior phase, including everything added in this revision.

---

## Database Constraints & Indexes (Consolidated)

Every constraint below is already implied by its owning phase's schema/security sections; this list exists so implementation doesn't have to reconstruct it by re-reading every phase. Table names match the phase sections above exactly — no renaming.

**Uniqueness constraints**
- `users.email` unique.
- `academies.slug` unique.
- `branches`: `(academy_id, code)` unique.
- `students`: `(academy_id, student_number)` unique (Phase 2, report §12's core requirement).
- `student_id_cards.card_number` unique.
- `certificates.certificate_code` unique.
- `certificates`: `(student_id, batch_id)` unique — at most one certificate per completed batch (Planning Gaps Resolution §7/§15).
- `notifications`: `(idempotency_key, channel)` unique.
- `receipts.receipt_number`: unique per academy.
- `subscription_payment_consumptions.subscription_payment_id` unique (the renewal-reuse guard).
- `grade_bands`: no-overlap exclusion constraint on `(grade_configuration_id, numrange(min_mark, max_mark))` (Phase 3, `btree_gist`).
- `staff_branch_assignments`: unique `(staff_id, branch_id)`.
- `batch_enrollments`: unique `(student_id, batch_id)` for active enrollments.
- `academy_memberships`: unique `(user_id, academy_id)`.

**Non-negativity / valid-range constraints**
- All `*_amount_cents` columns: nonnegative, except reversal/adjustment rows which are explicitly signed/linked (never a bare negative main transaction).
- `academy_subscriptions`: `ends_at >= starts_at`; `trial_ends_at`, when set, `>= starts_at`.
- `grade_bands`: `max_mark >= min_mark`.

**Foreign keys**
- Every academy-scoped table carries `academy_id` FK to `academies`; branch-specific tables also carry `branch_id` FK to `branches`.
- `certificates.batch_id` FK to `batches`, required (Phase 5 eligibility check).
- `subscription_payment_consumptions.subscription_payment_id` FK to `subscription_payments`; `.academy_subscription_id` FK to `academy_subscriptions`.
- `result_corrections.original_result_id` FK to `exam_results`; `student_payments.reversed_payment_id` / `expense_records.reversed_record_id` are self-referencing nullable FKs.
- Deletion behavior: academy-scoped child tables use `ON DELETE RESTRICT` in practice (nothing in this plan ever hard-deletes an `academies`/`branches`/`students`/`courses` row that has dependents — archive/deactivate instead, per every phase's "no hard delete" language).

**Indexes to add alongside the tables above** (beyond what a PK/unique constraint already creates): `sessions(user_id)`, `sessions(expires_at)`, `audit_logs(academy_id, created_at)`, `audit_logs(actor_user_id, created_at)`, `audit_logs(request_id)`, `academy_memberships(academy_id, user_id)`, `branches(academy_id)`, `students(academy_id)`, `staff_profiles(academy_id)`, `batch_enrollments(academy_id, student_id)`, `student_payments(academy_id, created_at)`, `subscription_payments(subscription_id)`, `notifications(status, created_at)` (for the worker's retry scan), `certificates(certificate_code)` (mirrors the unique constraint but called out since it's the hot path for public verification).

---

## Lifecycle & State-Transition Tables

Formalizes four lifecycles that were previously implied by prose rather than stated as explicit transition tables (Planning Gaps Resolution §4–§7). Same format as the Phase 1 subscription state-transition table: every listed transition is the only way that state change can happen; anything not listed is rejected server-side.

### Result Lifecycle (Phase 3)

| From | To | Trigger | Actor | Reason required | Audited |
|---|---|---|---|---|---|
| — | `Draft` | `createExam` implicitly creates a `Draft` `exam_results` row per enrolled student | system, on exam creation | no | yes |
| `Draft` | `Marks Entered` | `enterMarks` (partial or full) | Trainer (assigned batch only) / Manager / Admin / Owner | no | yes |
| `Marks Entered` | `Submitted` | `submitResults` | same as above | no | yes |
| `Submitted` | `Under Review` | automatic on submission (no separate action) | — | no | yes |
| `Under Review` | `Approved` | `approveResult` | Manager / Admin / Owner (never the submitter) | no | yes |
| `Under Review` | `Rejected` → back to `Draft` | `rejectResult` | Manager / Admin / Owner | **yes** | yes |
| `Approved` | `Published` | `publishResults` — a distinct, separate action/click from Approve (§11.7 copy: "Published results are locked and cannot be edited directly") | Manager / Admin / Owner | no | yes |
| `Published` | *(no direct edit)* | — | — | n/a | n/a |
| `Published` | `Correction Requested` | `requestResultCorrection` | Manager / Admin / Owner | **yes** | yes |
| `Correction Requested` | `Corrected → Reapproved → Republished` | routes through the same `approveResult`/`rejectResult` queue; approval **is** the republish trigger — the corrected value takes effect on the same row the instant it's approved, no separate manual "publish" click | Manager / Admin / Owner (never the requester) | no (reason already captured at request time) | yes, before/after values recorded |
| `Correction Requested` | back to `Published` (unchanged) | correction rejected | Manager / Admin / Owner | **yes** | yes |

Immutable fields once `Published`: `marks_obtained`, `grade_configuration_id`, `grade_band_label`, `pass_fail` — changeable only via an approved correction, which updates them in place and writes the before/after to `result_corrections` and the audit log. Students never have their own login (no student portal, per Explicitly Out of Scope) — "whether students can see the result" is moot; results are visible only to academy staff per the Master Permission Matrix.

### Grade-Configuration Lifecycle (Phase 3)

| From | To | Trigger | Actor | Notes |
|---|---|---|---|---|
| — | `Draft` | `createGradeConfiguration` | Admin / Manager | exclusion constraint enforced immediately, even in `Draft` |
| `Draft` | `Pending Approval` | `submitGradeConfigForApproval` | Admin / Manager | — |
| `Pending Approval` | `Approved` | `approveGradeConfig` | **Manager, and Academy Owner via their existing `Full` authority — not Academy Administrator**, who holds `Manage` only on grade-band configuration per the Master Permission Matrix, not `Approve` (never the submitter) | — |
| `Pending Approval` | back to `Draft` | rejected | **Manager, and Academy Owner via `Full` authority — not Academy Administrator**, same approval-authority scoping as the `Approved` row above | reason required |
| `Approved` | `Active` | activation (only one `Active` configuration per academy at a time) | Admin / Manager | the previously `Active` row (if any) flips to `Retired` in the same transaction |
| `Active` | *(no in-place edit)* | any change creates a **new** `Draft` revision instead | — | Published results keep the `grade_configuration_id` snapshot they were published against — retiring a configuration never changes any existing result |

### Finance Lifecycle (Phase 4) — per entity

| Entity | Draft/Pending → | Approved/Posted → | Rejected | Reversed/Voided |
|---|---|---|---|---|
| `student_charges` | `open` (created directly by Manager or Finance Officer, no approval step — see status-derivation note below) | `partially_paid` / `paid` (derived automatically, not a manual transition — see below) | — | `cancelled` (reason required; only from `open` or `partially_paid`, never from `paid`) |
| `student_payments` | `pending_approval` (recorded by Finance Officer or Manager) | `approved` (**Manager only**, per the Master Permission Matrix's `Approve/Manage` cell on this entity — Academy Owner and Academy Administrator are `View`-only here, never approvers; never the recorder) | `rejected` (reason required) | `reversed` from `approved` only (reason required, produces a new linked row) |
| `income_records` | `posted` directly by **Manager or Finance Officer** (no approval step — no dedicated Master Permission Matrix row exists for income specifically, so this reuses the same recording capability the matrix already grants those two roles for `student_payments`, rather than inventing a new permission) | — | — | `reversed` (reason required, new linked row) |
| `expense_records` | `draft` → `pending_approval` (`submitExpenseForApproval`, by Finance Officer per its `Create/Submit` cell) | `approved` (**Academy Administrator or Manager only**, per the Master Permission Matrix's `Approve` cells on this entity — Academy Owner is `View`-only and Finance Officer is `Create/Submit`-only, never approvers; never the submitter) | `rejected` (reason required) | `reversed` from `approved` only (reason required, new linked row) |
| `receipts` | issued directly on payment approval (`issueReceipt`) — no separate approval state | — | — | never reversed directly; reversing the underlying `student_payments` row leaves the receipt record in place, marked against a now-reversed payment |

**`student_charges` status derivation** (completing the schema's `open`/`partially_paid`/`paid`/`cancelled` states): `open` is the initial state set by `createStudentCharge`. Whenever a `student_payments` row referencing this charge is **approved** (Manager only, per the corrected rule above), the charge's paid-to-date total is recalculated inside that same approval transaction: the charge becomes `partially_paid` if the total is greater than zero but less than the charge amount, or `paid` if the total meets or exceeds it. This is a derived side effect of payment approval — not a separate manual action, and not a new payment workflow. `open`/`partially_paid` → `cancelled` uses the existing charge-cancellation path (reason required); a `paid` charge is never cancelled.

**No posted financial record is ever deleted under any code path, for any of the five entities above** — reversal only, original row untouched, matching the existing DB-level "no hard delete" language restated here explicitly per entity (Planning Gaps Resolution §6).

### Certificate Lifecycle (Phase 5)

| From | To | Trigger | Actor | Reversible | Audited |
|---|---|---|---|---|---|
| *(computed, not stored)* | `Eligible` | at least one `Published` + `pass` `exam_results` row exists for `(student_id, batch_id)` | — | n/a | n/a |
| `Eligible` | `Issued` | `issueCertificate(studentId, batchId)` — eligibility check + insert in one transaction, blocked by the `(student_id, batch_id)` unique constraint | Owner / Admin / Manager (per Master Permission Matrix's `Full`/`Manage`/`Manage` cells on Certificates) | no | yes |
| `Issued` | `Cancelled` | `cancelCertificate` | Owner / Admin / Manager | **yes, reason required** | yes |
| `Cancelled` | *(terminal)* | — | — | — | a cancelled certificate is never re-activated; it stays permanently visible on `/verify` as "cancelled," never removed |

No `Draft`, `Generated`, `Reissued`, or `Expired` states exist (Planning Gaps Resolution §7) — a certificate is immutable data the moment it's issued; "reissue" is re-viewing/re-downloading the same record, not a new transition or row. Behavior is unchanged whether the issuing academy is open, suspended, or permanently closed — `/verify/[certificateCode]` works identically in every case (already decided).

---

## File Storage Operational Limits

(Planning Gaps Resolution §8 — all numbers below are MVP defaults, easy to revise later.)

| Rule | Value |
|---|---|
| Max individual file size — documents (PDF/scans) | 10MB |
| Max individual file size — images (logo, ID photos) | 5MB |
| Allowed MIME types | `application/pdf`, `image/jpeg`, `image/png`, `image/webp` — nothing else, enforced by a shared Zod upload schema before any upload begins |
| Filename normalization | lowercased, non-alphanumeric collapsed to `-`, original extension preserved |
| Duplicate/replace | replacing a file in an already-filled slot deletes the old object immediately and frees its allowance — no versioning (already decided) |
| Failed upload | never consumes allowance; any partially-written object is cleaned up, never left orphaned |
| Delete/archive | deleted or replaced files are hard-removed from storage immediately — this is *file* lifecycle, distinct from the "no hard delete" principle for financial/result *records* |
| Signed download URL expiry | 15 minutes |
| Public vs. private | every academy-owned file is private by default; there is no public bucket anywhere, including certificate PDFs |
| Storage-quota recalculation | the Phase 5 reconciliation job runs daily, flags drift against actual object-storage contents rather than silently trusting the counter |
| Downgrade | a plan downgrade is blocked if current storage usage exceeds the target plan's `max_storage_bytes` (same `checkAllowance`-blocks-downgrade rule as every other resource) |
| Platform-admin files (subscription-payment evidence) | excluded from every academy's storage quota (already decided) |
| Virus/malware scanning | **out of scope for MVP**, deferred to the hosting decision — same deferral pattern as backup RPO/RTO |

---

## Pagination, Search & Export Limits

(Planning Gaps Resolution §9.)

| Rule | Value |
|---|---|
| Default page size | 25 |
| Max page size | 100 |
| Pagination style | offset (simplest, sufficient at MVP scale — no cursor pagination) |
| Max export row count | 10,000 rows per export call; beyond that, `exportData` is rejected with a message asking the user to narrow filters, not a silent truncation |
| Export generation | synchronous CSV stream for MVP — no `export_jobs` table, no async generation |
| CSV encoding | UTF-8 with BOM (Excel compatibility) |
| Dates in exports | ISO 8601 |
| Money in exports | academy's `default_currency`, two-decimal display |
| Scope | export always returns exactly the same rows the equivalent on-screen list/report would for that caller's role/tenant/branch (already decided) |
| Audit | every `exportData` call is audit-logged (`action = "data.export"`, already decided) |

---

## Account & Membership Lifecycle

(Planning Gaps Resolution §11.)

- A disabled `users.status` account cannot obtain a session under any path, MFA-enrolled or not — checked first, before password verification, in `signIn`.
- Removing an academy membership revokes that user's active sessions for that academy context; if it was their only membership anywhere (no other academy, no platform role), every session is revoked.
- **Last-owner protection**: an academy must always retain at least one active Academy Owner. `removeMembership`/role-change actions reject any change that would leave zero, enforced server-side — not just a disabled UI button.
- A user account may hold a platform membership and academy membership(s) simultaneously with no restriction — the two membership tables are independent; the app shell renders whichever context (`DESIGN.md` §2.1) the current session is in.
- Archived/removed staff keep every historical reference intact (audit rows, past approvals, past mark-entry records) — every FK from a historical record to `staff_profiles`/`users` is `ON DELETE RESTRICT`, never cascade-null.
- Password-reset tokens and MFA recovery codes: already single-use/TTL-bound by their existing schema (Phase 0) — no additional lifecycle rule needed.

---

## Archive & Deactivation Rules

(Planning Gaps Resolution §12.) General rule: **archive/deactivate, never delete**, for every operational entity below — the same posture already applied to financial/result records.

| Entity | Archivable by | Blocked if active children exist | Searchable/reportable while archived | Counts toward allowance | Restorable |
|---|---|---|---|---|---|
| Branches | Owner/Admin (Manage: Manager) | yes — must reassign/archive staff & students first | yes | no | yes, by the same roles |
| Staff | Owner/Admin (Manage: Manager) | no | yes | no | yes |
| Students | Owner/Admin/Manager/Admissions (assigned) | no | yes | no | yes |
| Courses | Owner/Admin (Manage: Manager) | yes — must archive/complete batches first | yes | no | yes |
| Programs | Owner/Admin | yes — must archive courses first | yes | n/a (not a capped resource) | yes |
| Batches | Owner/Admin/Manager | no (moves to `completed`/`archived`) | yes | n/a | yes |
| Enrollments | Owner/Admin/Manager (`withdrawn` status) | no | yes | n/a | yes (re-enroll) |
| Documents (staff/student) | Owner/Admin/Manager (`archived` status) | no | yes | no (frees storage allowance) | yes |
| Timetables | Owner/Admin/Manager | no | yes | n/a | yes |
| Charges | Owner/Admin/Manager (`cancelled` status) | no | yes | n/a | no (cancellation is terminal) |
| Certificates | Owner/Admin/Manager (`cancelled` status) | no | yes, permanently (public verification) | n/a | no (cancellation is terminal, per Certificate Lifecycle above) |

---

## Database-Level Tenant Protection

(Planning Gaps Resolution §13.) **Postgres Row-Level Security stays deferred, post-MVP** — application-layer isolation is mandatory and sufficient for MVP, for these reasons:
- Every academy-scoped query goes through a single query-builder helper that injects `academy_id` from the trusted, server-resolved `AuthContext` — never a client-supplied parameter (the core architecture decision, unchanged).
- No cross-tenant FK is possible by construction — every child table's `academy_id` is validated against its parent's `academy_id` at write time (e.g. a new student's `branch_id` must belong to that student's `academy_id`), not just carried as a bare column.
- Background jobs (BullMQ) carry `academy_id` explicitly in their job payload — a worker never infers tenant context from ambient state.
- Tenant-isolation failures are tested via the two-academy control-group pattern already required in every phase's "How to test" section.
- RLS remains available as a Phase 5+ hardening addition if a defense-in-depth need is identified later — not required for MVP given the guarantees above are already comprehensive and independently tested.

---

## Transaction Boundaries

(Planning Gaps Resolution §14.) Every multi-step sensitive action below writes all of its listed parts atomically, in one DB transaction — if any step fails, the entire transaction rolls back, never a partially-applied state:

- Academy approval → `academies.approved_by`/`approved_at` + audit row.
- Subscription activation/suspension/reactivation/cancellation/closure → `academy_subscriptions`/`academies` state change + audit row.
- Payment verification → `subscription_payments.status` + audit row.
- Subscription renewal → payment lock + consumption row + `academy_subscriptions` update + audit row (already fully specified in Phase 1 §6).
- Student enrollment → `batch_enrollments` insert + `academy_usage` counter increment.
- Result publication → `exam_results.status`/`published_at` + audit row.
- Certificate issuance → eligibility check + `certificates` insert (blocked by the unique constraint) + audit row.
- Expense/payment approval → status change + audit row.

**No outbox pattern for MVP** — a single-process Next.js app writing to one Postgres database via one transaction has no distributed-systems problem for an outbox to solve; this is a deliberate simplification, not an oversight.

---

## Concurrency & Idempotency

(Planning Gaps Resolution §15 — extends the `renewSubscription` locking pattern, already fully specified in Phase 1 §6, to every other place a race matters.)

| Action | Guard |
|---|---|
| Payment verification (`verifySubscriptionPayment`, `approveStudentPayment`) | row-locked status check — two concurrent calls on the same row: one succeeds, one gets a clear "already processed" error |
| Certificate issuance | `(student_id, batch_id)` unique constraint — a race produces one success, one rejected insert |
| Student-ID / receipt-number generation | a DB sequence or unique-constraint-with-retry — never a racy `SELECT MAX(...) + 1` |
| Notification dispatch | idempotency key `(event_type, entity_id)` — already specified |
| Export generation | no idempotency key needed — exports are read-only and mutate nothing, so there's no double-spend risk to guard against |

---

## API & Server-Action Contract

(Planning Gaps Resolution §16.) Every server action returns one of two shapes: `{ ok: true, data }` on success, `{ ok: false, error: { code, message } }` on failure. Fixed error-code enum: `UNAUTHENTICATED`, `UNAUTHORIZED`, `VALIDATION_ERROR`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `INTERNAL_ERROR`. **Cross-tenant existence never leaks**: a record that exists but belongs to another tenant/branch the caller can't see returns the exact same `NOT_FOUND` a genuinely nonexistent ID would — never a distinguishable `UNAUTHORIZED`, which would itself confirm the record exists. This is the concrete rule behind every IDOR test required throughout this plan.

---

## Observability Requirements

(Planning Gaps Resolution §17 — consolidates what's already specified elsewhere, adds correlation-ID propagation.)

- Structured application logs with secret/PII redaction (Phase 0, already specified).
- **Correlation ID**: one `request_id` generated per incoming HTTP request, already present on `audit_logs` rows (Phase 0 schema) — threaded through to any background job that request enqueues, so one ID follows a user action from HTTP request → server action → audit row(s) → BullMQ job → notification delivery status.
- Sentry-class error tracking (already Phase 5), extended to BullMQ queue health and storage/email/SMS provider health.
- Health/readiness/liveness endpoints (already in the Release Checklist).
- Alert thresholds, stated concretely rather than left implicit: 3 consecutive background-job failures for the same job type; queue depth exceeding 100 for more than 5 minutes; error-tracking spike beyond baseline.

---

## Privacy & Data Retention

(Planning Gaps Resolution §19.)

- **Indefinite retention by default** for operational, financial, audit, and certificate data — consistent with the no-hard-delete principle and the archive-on-closure model (closed academies stay retained and read-only forever; certificates stay verifiable forever).
- Session records, password-reset tokens, and MFA recovery codes expire per their existing TTL/single-use fields — no additional retention rule needed.
- **No GDPR-style erasure/right-to-be-forgotten mechanism in MVP** — no legal mandate identified for the target market; building one would directly conflict with the no-hard-delete/audit-integrity principles core to this product's trust model. Stated as an explicit assumption, revisit if a specific legal requirement is identified later.
- Public verification data (`/verify/[certificateCode]`) is always available regardless of any retention policy elsewhere — already the standing rule for closed academies, restated as the general case.

---

## Cross-Phase Testing Strategy

Consolidates test categories that recur across every phase above into one reference so coverage can be checked holistically rather than only phase-by-phase. Every test listed here restates something already required in a phase's "How to test" section — nothing new is introduced.

**Security / authentication**: password-policy rejection; session token hashing/expiry/revocation; TOTP enrollment-forced-on-first-login and challenge-required-every-login for `platform_owner`; recovery-code single-use; rate limiting on `/login`/`/forgot-password`/`/mfa/challenge`; suspicious-login detection (new IP/user-agent); IDOR checks on every "view own record" action (`revokeSession`, branch-scoped resources, `/academy/audit-logs`).

**Tenant and branch isolation**: two-academy control-group pattern throughout (register Academy A and B, assert every list/detail/export/audit-log query for A never returns a B row, including via a guessed ID/URL); branch-limited roles (Admissions Officer, Trainer) never see another branch's records; academy-wide roles correctly see all branches.

**Permissions**: every cell in the Master Permission Matrix above has a positive test (role can do X) and a negative test (every other role cannot); every ungrantable capability (the full set named in the Master Permission Matrix and Cross-Cutting Architecture Decisions above — `plans.manage`, `platform.revenue.view`, `platform.staff.manage`, and every academy-lifecycle/payment-verification action) is unsatisfiable for `platform_admin` under every possible grant combination; self-approval is blocked for every approval queue (results, grade configs, student payments, expenses).

**Data integrity**: every uniqueness/FK/non-negativity constraint in the "Database Constraints & Indexes" section above has a test that violates it and confirms rejection; transaction rollback on partial failure (e.g. a `renewSubscription` step 5 failure leaves no consumption row); concurrent-write races (the `renewSubscription` double-spend test, concurrent branch/student creation at the allowance boundary).

**Workflows**: onboarding (registration → checklist → approval → payment verification → activation, blocked at each unsatisfied precondition); the full subscription-transition table; result Draft→Published→Correction; grade-config Draft→Pending→Active; finance charge→payment→approval→receipt; expense create→approve→post; certificate issue→verify→cancel→verify.

**Allowances**: hard block at the limit for every capped resource (branches/students/staff/courses/storage); downgrade blocked while over the target plan's limits; usage bars/figures match actual counts after `recalculateUsage`.

**Audit logs**: every sensitive action from the Master Permission Matrix produces a row with actor/role/action/entity/before/after/result; a sensitive mutation cannot succeed if its audit write fails (same-transaction test); secrets (passwords, tokens, MFA data, payment-evidence file bytes) never appear in `before`/`after`/`context`; academy users cannot query another academy's or the platform's audit rows.

**Background jobs**: notification idempotency key prevents duplicate sends on retry/duplicate-enqueue; exponential backoff and a fixed retry cap; a job that exhausts retries is marked failed and visible, never silently dropped or retried forever.

**Playwright / E2E**: the full cross-module journey defined in Phase 5's "How to test" (MFA sign-in → register/activate academy → branch/staff/student within allowance → batch/exam/publish → finance approval → certificate issue/verify → close a second control academy and confirm its certificate still verifies) with zero cross-tenant leakage asserted at every step.

**CI checks**: typecheck, lint, unit tests, integration tests, migration-apply-cleanly-on-fresh-DB, production build, `npm audit` (or equivalent) — all required green before a phase is considered mergeable, per each phase's own "How to test" section.

---

## Final Documentation & Release Checklist

Operational readiness items to define before production release. **Hosting-provider-specific numbers (exact backup frequency, RPO/RTO, health-check endpoints tied to a specific platform) remain explicitly deferred until a deployment target is chosen, consistent with this plan's existing "Deployment target is undecided" stance** — everything below is written provider-agnostically; picking a provider only fills in numbers, it doesn't change any decision already made in this plan.

**Deployment & Ops Decisions** (Planning Gaps Resolution §18 — every row below is explicitly non-blocking for implementation, since `lib/storage`/`lib/email`/`lib/sms` are already built behind provider-agnostic interfaces; revisit each before production release):

| Decision | Status |
|---|---|
| Production hosting provider | Deferred — non-blocking |
| PostgreSQL hosting | Deferred — non-blocking |
| Redis hosting | Deferred — non-blocking |
| Object storage provider | Deferred — non-blocking |
| Email provider | Deferred — non-blocking |
| SMS provider | Deferred — non-blocking |
| Domain / DNS / TLS management | Deferred — non-blocking |
| Secrets-management approach | Deferred — non-blocking (requirement fixed now: env-injected, never committed, never logged) |
| Monitoring provider | Deferred — non-blocking (requirement fixed now: Sentry-class tool required) |
| Backup schedule / retention / RPO / RTO | Deferred — non-blocking (requirement fixed now: the backup+restore drill itself is required before release, per Phase 5) |

- **Environment variables**: an inventory of every required env var (DB connection, Redis connection, session/MFA encryption keys, email/SMS provider credentials, storage credentials, `NODE_ENV`) with a checked-in `.env.example`; `resetPassword`/`signIn`/MFA/storage code paths fail loudly at startup if a required var is missing, never silently degrade.
- **Local development setup**: PostgreSQL (official Windows installer) and Memurai (Redis-protocol-compatible native Windows service) run as local Windows services — no Docker/containers; a documented `npm install && migrate && seed` gets a working local instance.
- **Seed & Demonstration Data** (Planning Gaps Resolution §20): the seed script produces a full demo dataset — one MFA-enrolled `platform_owner`, one demo academy with 2 branches, a demo Academy Owner plus one account per academy role, ~10 demo students, 2 demo courses/batches with a published result set, a handful of recorded payments/expenses, and one issued certificate — enough to exercise every screen without manual data entry during development or demos. The script refuses to run unless `NODE_ENV !== 'production'`. Demo credentials live only in `.env.example`/README, never committed as if they were real secrets.
- **Database migrations**: Drizzle Kit-generated, checked into version control, applied in CI against a fresh database on every run (already a Phase 0 CI check); a documented rollback path for the most recent migration.
- **Deployment**: provider-agnostic build/deploy steps (build the Next.js app, run pending migrations, start the app + the BullMQ worker as a separate process); rollback = redeploy the previous build artifact + (if needed) the migration rollback above.
- **Secrets management**: never committed; provider-specific secret store is a deployment-time choice, but the requirement — secrets injected via environment, never hardcoded, never logged — is fixed now.
- **Health checks**: an application health endpoint (DB reachable, Redis reachable) and a worker health check (queue connection alive); both are provider-agnostic checks a load balancer or process manager can poll regardless of host.
- **Monitoring**: Sentry-class error tracking (already Phase 5) extended to BullMQ queue health and email/SMS/storage provider health, with alert thresholds for repeated failures — provider for the monitoring tool itself is a Priority-C choice, the requirement to have one is fixed now.
- **Backup / restore**: a documented, tested restore procedure against a seeded database (already a Phase 5 deliverable); exact frequency and RPO/RTO numbers are deferred to the hosting decision, but the drill itself — take a backup, destroy the environment, restore, verify data integrity — is required before release regardless of provider.
- **Incident response**: `platform_owner` (or a designated platform admin, once staff/grant management exists) is the incident-response owner for MVP; no formal on-call rotation is in scope, consistent with this being a single-operator SaaS at MVP stage.
- **External support process**: per Decision #14, support is handled outside the product (email/phone) — no in-app ticketing exists or is planned; this checklist item is "confirm the out-of-band contact channel is documented for academy owners," not a feature to build.

---

## Recommended Flat Implementation Order

Each item is independently implementable and testable. Phases are sequential; items within a phase are sequential.

**Phase 0 — Foundation**
1. Repo scaffold: Next.js + TypeScript, native Windows Postgres + Memurai (no Docker), env management.
2. Drizzle setup + first migration (`users`, `sessions`, `password_reset_tokens`).
3. Structured logger with secret/PII redaction.
4. Password hashing (Argon2id) + **password policy (min 12 chars)** + unit tests.
5. Session issuance/validation (hashed-token cookie) + unit tests.
6. `signIn`/`signOut` server actions + `/login` page (password step).
7. Redis rate limiter wired to `/login`.
8. Password reset flow + rate limiting.
9. `platform_memberships`, `platform_admin_permissions` migration.
10. `getAuthContext()` + `hasPermission()` (incl. ungrantable-capability list) + role constants.
11. `audit_logs` migration (expanded: actor_role, branch_id, context, result) + `recordAudit()` helper.
12. Protected stub route proving the auth+permission gate works.
13. `mfa_totp_credentials`/`mfa_recovery_codes` migration + `enrollMfa`/`verifyMfaEnrollment` + `/mfa/setup`.
14. `challengeMfa` + `/mfa/challenge`, wired into `signIn` — mandatory for `platform_owner`, forced enrollment on first login.
15. `regenerateRecoveryCodes` + display-once UI.
16. `listMySessions`/`revokeSession`/`revokeAllOtherSessions` + `/account/security` page.
17. Suspicious-login detection (`checkSuspiciousLogin`) writing an `audit_logs` row on new device/IP.
18. CI pipeline + seed script for one `platform_owner` (MFA-enrolled).

**Phase 1 — SaaS Core Platform**
19. `academies` (expanded profile fields, `created_by`/`approved_by`/`approved_at`, `closed_at` — **no `status` column**), `branches` (+address/phone), `academy_memberships` migration.
20. `registerAcademy` (transactional, expanded fields) + `/platform/academies/new`.
21. `approveAcademy` (sets `approved_by`/`approved_at`) + `getOnboardingChecklistStatus` gating `activateAcademy` + academy list/detail.
22. `subscription_plans` migration + plan CRUD (`plans.manage`, ungrantable) (`/platform/plans`).
23. `academy_subscriptions` migration (+renewed_at/renewed_by) + full state-transition-table implementation incl. 7-day grace computation and `Trial → Expired` lazy flip + unit tests per transition.
24. `createAcademySubscription` wired into registration.
25. `subscription_payments` migration (+evidence_file_ref) + record/verify/reject/reverse (`/platform/payments`).
26. `activateAcademy`/`suspendAcademy`/`reactivateAcademy`/`cancelAcademy`/`closeAcademy` + audit logging.
27. Subscription-status gate middleware for `/academy/*` (incl. grace period and closure blocking).
28. Minimal `/academy/dashboard` shell.
29. `academy_usage` migration + `recalculateUsage` + `checkAllowance()` helper (hard block) (`/platform/usage`).
30. `subscription_payment_consumptions` migration + `renewSubscription` (Active/Past Due/Suspended/Expired only, requires a verified unconsumed payment, locks the payment row, extends `ends_at` from `max(current ends_at, now)`, auto-reactivates if not already Active, atomic transaction per the algorithm above) + concurrent-renewal race test + expiring-soon indicator on `/platform/subscriptions`.
31. Platform staff + explicit grants + UI-only permission-group presets (`/platform/staff`) + ungrantable-capability denial test.
32. `/platform/audit-logs` viewer + `/platform/reports` (revenue breakdowns, expected vs. collected).

**Phase 2 — Academy Operations**
33. `staff_profiles`, `staff_branch_assignments`, `staff_documents` migration.
34. Branch CRUD (`/academy/branches`) + `checkAllowance('branches')`.
35. Staff create/update + role assignment + `checkAllowance('staff')` (`/academy/staff`, `/academy/staff/new`).
36. Staff branch assignment (many-to-many) + branch-scoped filter + IDOR test.
37. `students`, `student_documents` migration with `(academy_id, student_number)` unique constraint.
38. `generateStudentId` + `registerStudent` + `checkAllowance('students')` + cross-tenant/duplicate-ID tests.
39. Student search/update (`/academy/students`), admissions view.
40. `student_id_cards` migration + issue/reprint actions.
41. `updateAcademySettings` (expanded fields, direct edit) + `getOwnAcademyUsage` widget.
42. `/academy/audit-logs` route (Owner/Admin only).

**Phase 3 — Training Operations**
43. `programs`/`courses`/`batches` migration + CRUD + `checkAllowance('courses')`.
44. `batch_trainer_assignments` + `batch_enrollments` + trainer-scoped access checks.
45. `timetables` migration + CRUD — no attendance fields.
46. `grade_configurations`/`grade_bands` migration + overlap/gap validation + exclusion constraint.
47. Grade config approval flow (`/academy/grades`).
48. `exams`/`exam_results` migration + `createExam`/`enterMarks` with trainer-batch scoping.
49. Result submit/approve/reject/publish flow (`/academy/results`) + immutability test.
50. `result_corrections` + `approval_requests` migration + `requestResultCorrection` flow.

**Phase 4 — Finance**
51. `student_charges`/`student_payments`/`receipts` migration + create/record/issue actions.
52. Approval wiring + self-approval rejection test.
53. `income_records`/`expense_records` migration + create/approval flow (`/academy/finance`).
54. `reverseTransaction`/`adjustTransaction` + no-hard-delete tests.
55. Finance reports + test confirming subscription data never appears in academy finance views.

**Phase 5 — Credentials & Release**
56. `certificates` migration (incl. `batch_id`) + `issueCertificate` (eligibility: published Pass result required in that batch)/`cancelCertificate` (`/academy/certificates`).
57. `certificate_verifications` + public `verifyCertificate` + `/verify/[certificateCode]` (works for closed academies).
58. `notifications` migration + BullMQ worker + fixed templates for the **full event catalog**, wired into every trigger point across Phases 0–4.
59. `/academy/notifications` delivery-status view + notification-preference toggles.
60. `exportData` action + export UI on Reports, Student list, Finance, Audit logs (platform + academy).
61. Finalize `/academy/reports`/`/platform/reports`; finalize `/platform/settings`.
62. Operational monitoring/alerting: queue health, storage/email/SMS provider health, alert thresholds.
63. Systematic security re-audit across all prior + new actions (Zod / permission / tenant-scope / audit-log checklist).
64. Dependency vulnerability scan.
65. Full Playwright end-to-end suite (two-academy isolation, MFA flow, allowance limits, closure/verification).
66. Backup + restore drill (numeric RPO/RTO deferred to deployment-time decision).
67. Production release checklist sign-off.

---

## Explicitly Out of Scope

Attendance tracking, student self-service portal, online subscription payment gateway, automated payment webhooks, full accounting package, payroll, inventory, library management, full LMS/video platform, native mobile apps, advanced CRM, bulk/CSV student import, admin-editable notification templates, in-product support ticketing, refunds as a distinct concept (modeled as a reversal, per Planning Gaps Resolution §6), financial-period closing, certificate reissuance as a distinct feature (re-download the existing record instead), GDPR-style data erasure / right-to-be-forgotten, virus/malware scanning on uploads (deferred to the hosting decision).

---

---

## Final Planning Approval Checklist

(Planning Gaps Resolution §22.)

- [x] All permission contradictions are resolved — Master Permission Matrix, Planning Gaps Resolution §1.
- [x] One authoritative planning document is identified — "Planning Authority & Source of Truth" section.
- [x] All Phase 2–5 schemas are complete — each phase's "Database tables" subsection.
- [x] Subscription lifecycle is formally defined — Phase 1 §6 state-transition table (pre-existing).
- [x] Result lifecycle is formally defined — Lifecycle & State-Transition Tables, Result Lifecycle.
- [x] Grade-configuration lifecycle is formally defined — Lifecycle & State-Transition Tables, Grade-Configuration Lifecycle.
- [x] Finance lifecycle is formally defined — Lifecycle & State-Transition Tables, Finance Lifecycle.
- [x] Certificate lifecycle is formally defined — Lifecycle & State-Transition Tables, Certificate Lifecycle.
- [x] Account and membership lifecycle is defined — Account & Membership Lifecycle.
- [x] Archive and deactivation rules are defined — Archive & Deactivation Rules.
- [x] Storage limits and file lifecycle rules are defined — File Storage Operational Limits.
- [x] Pagination and export limits are defined — Pagination, Search & Export Limits.
- [x] Notification retry and idempotency rules are defined — Phase 5 Notifications security considerations.
- [x] Transaction boundaries are documented — Transaction Boundaries.
- [x] Concurrency and idempotency rules are documented — Concurrency & Idempotency.
- [x] API and server-action contracts are standardized — API & Server-Action Contract.
- [x] Tenant-isolation strategy is documented — Database-Level Tenant Protection.
- [x] Privacy and retention rules are documented — Privacy & Data Retention.
- [x] Deployment and backup decisions are documented — Final Documentation & Release Checklist, Deployment & Ops Decisions table.
- [x] Phase-specific acceptance tests are measurable — each phase's "Acceptance criteria" subsection.
- [x] All blocking decisions are resolved — `PLANNING_GAPS_RESOLUTION.md`, all 22 items.
- [x] The plan explicitly states that implementation may begin — see below.

---

**All planning gaps resolved — ready for implementation approval.**
