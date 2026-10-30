# Performance Optimization Plan: Dardar School System

Prioritized from the findings in `PERFORMANCE_AUDIT.md`, with "before" numbers taken from `PERFORMANCE_BASELINE.md`. **Nothing here has been implemented.** Each item is meant to be reviewed, approved, and shipped on its own.

**How to read the estimates:** today one database round-trip costs about 207 ms, and a new connection costs about 1.4 s. Unless an item says "measured", every gain below is an **estimate**, calculated as (waves removed × 207 ms) or (queueing removed). Each item must be re-measured with the harness after it is implemented.

## Status (2026-10-30)

| Item | Status | Notes |
|---|---|---|
| P0.1–P0.3 | Open, needs a decision | Production region, dev DB region and dev-data clean-up are yours to decide |
| P1 Pool idle / keep-alive | **Done** | `lib/db/index.ts` |
| P2 Auth + gate collapse | **Done** | 4 lookups → 2 |
| P3 Shell consolidation (items 1–2) | **Done** | Item 3 (streaming bell) not done: changes the client shell's contract |
| P4 Page waterfalls | **Done**: timetable, students, student detail, finance payments tab | ID cards: no independent stages left. Finance charges tab: its overview depends on `canManage`, so left sequential |
| P5 Dashboard query diet | **Done** | New lightweight reads: `getStudentDashboardCounts`, `getStudentPaymentTotals`, `listUpcomingExams`, `listStaffSummaries` |
| P6 Withdraw dialog | **Done** | `getWithdrawDialogDataAction` |
| P7 Platform reports in SQL | **Done** | Trend, academies by plan, revenue (all four groupings) |
| P8 Results / exams bulk writes | **Done** | Marks entry now writes all-or-nothing (see the PERFORMANCE_BASELINE.md §8 notes) |
| P9 Generate-on-read | **Partly done** | Its two reads now run together; per-request caching deliberately not added (a cached enrollment could go stale inside a mutation) |
| P10 Indexes | Not done | Needs a migration, which you haven't approved; not needed at current data volumes |
| P11 / P12 | Not done | Low priority; browser hydration still unmeasured |

Measured results are in `PERFORMANCE_BASELINE.md` §8.

## Non-negotiable guardrails (apply to every item)

1. **No cross-request caching** of anything that depends on the user, the tenant, or finance data. Allowed techniques are: per-request `React.cache()` dedup, fewer round-trips, running independent reads in parallel, and aggregating in SQL instead of JS. Freshness stays exactly as it is today.
2. **Authorization semantics stay identical.**
   - A session is still re-validated on every request: revoked → reject, expired → reject.
   - The access gate keeps its order: closure first, then membership, then ambiguous academy, then current subscription, then the lazy flip, which is still persisted and audited.
   - Every `lib/` read keeps its own tenant / branch / role scoping. Running reads in parallel must never skip a check whose result decides what another read is allowed to return.
3. **Financial results must be identical.** Any change that touches a payment, balance, overdue, refund, or report path must ship with a before/after equality test on the same fixtures.
4. **Migrations need explicit approval.** Index changes (P10) and data clean-up (P0.3) are gated on your approval.
5. **Use only the test database.** Tests run against `TEST_DATABASE_URL`, as `vitest.config.ts` and `playwright.config.ts` already enforce. Measurement runs against the dev branch must stay read-only, the way the harness forces `default_transaction_read_only=on`.

---

## P0: Decisions, no code (do first)

| ID | Action | Why | Expected benefit | Risk |
|---|---|---|---|---|
| P0.1 | **Confirm where production runs** relative to Neon us-east-2 | Round-trip latency is bottleneck #1. If prod already runs in or near us-east-2, prod round-trips are about 1–3 ms, and the remaining items mostly fix development and future scale. | If prod is *not* co-located, moving it is the single largest win: a 17-wave page goes from about 3.5 s of network time to under 0.1 s (**estimate**). | None to decide. A move is an infrastructure change. |
| P0.2 | **Development database closer to developers.** Either a Neon project/branch in the nearest region, or a local Postgres for day-to-day dev (Neon stays for shared and test branches). | Every dev page pays about 207 ms per wave. | Dev page times drop roughly in proportion to the RTT ratio (**estimate**: 207 ms → about 20–40 ms regional, under 1 ms local). | The dev DB setup diverges from prod; migrations must still run against both. |
| P0.3 | **Remove leaked test fixtures from the dev branch**, either by resetting it from a clean seed or with a scripted delete. Needs your approval: it deletes data from the dev DB. | 20k users and 8.3k academies inflate every platform-wide query (two take 1.2–1.75 s measured). | Platform report queries shrink with the row count. | Irreversible on that branch. Take a Neon branch snapshot first. |

---

## P1: Connection lifecycle (`lib/db/index.ts`), config only

**Change**
- Raise `idleTimeoutMillis` from 30 s to a few minutes, e.g. 240 s. That keeps it just under Neon's 5-minute compute auto-suspend, which already drops connections; the existing `pool.on("error")` handler covers that case.
- Add `keepAlive: true`.
- Optionally benchmark Neon's `-pooler` endpoint against the direct endpoint, using the harness's cold-start runs, before switching.

**Evidence:** reconnects take 1.3–1.7 s each. Measured after more than 30 s idle: dashboard **8,522 ms** vs **3,027 ms** warm; refund-position action **4,236 ms** vs **1,509 ms** warm.

**Expected benefit:** removes about 1.4–5.5 s from the first request after 30 s–4 min of inactivity (**measured delta**; the size of the window is the estimate). This is very likely a large part of the 16.9 s dashboard you observed.

**Risks**
- Up to 10 connections are held open longer. Check that against the Neon compute's connection limit, and against any other processes (BullMQ worker, tests) connecting to the same branch.
- Check whether idle open connections affect Neon auto-suspend or billing for your plan.

**Tests:** the harness cold-run section (it waits 32 s), and a manual check after 2–3 minutes idle.

---

## P2: Collapse the auth and access-gate chain (every request and every action)

**Change: two queries instead of four sequential waves.**

- **`getAuthContext`** (`lib/auth/auth-context.ts`): one `sessions LEFT JOIN platform_memberships ON user_id` query. Keep the revoked/expired checks in code, exactly as `validateSessionToken` does today. Keep `validateSessionToken` and `resolveAuthContext` exported, unchanged for their other callers and tests.
- **`checkAcademyAccess`** (`lib/academies/access-gate.ts`): one query that joins memberships → `academies` (closed_at, plus name and logo_ref for the shell, see P3) and a `LEFT JOIN LATERAL` for the latest subscription (by `starts_at`). Ambiguous-academy detection still counts the active membership rows. Closure still overrides subscription status. `computeLazySubscriptionStatus` and `persistLazyStatusFlip` are untouched.

**Expected benefit:** −2 waves, about −0.4 s on **every** page and **every** server action (**estimate**; the 4-query chain measured 0.83–1.03 s). The refund action would drop from about 1.6–1.7 s to about 1.2–1.3 s, and the fee-period action from about 2.1–2.5 s to about 1.7–2.0 s.

**Risks:** this is the most security-sensitive change in the plan. A join mistake could admit a revoked session or an inactive membership, or pick the wrong subscription.

**Tests**
- The existing `lib/auth/session.test.ts`, `access-gate.test.ts` and `permissions.test.ts`.
- Add cases for: a revoked session; an expired session; an inactive membership; two active memberships (ambiguous); a closed academy that has an active subscription; multiple subscriptions where the newest by `starts_at` wins; trial → expired and past_due → suspended lazy flips (persisted plus one audit row); a platform admin with and without an academy membership.

---

## P3: Console shell and layout (`lib/console/shell-data.ts`, `lib/academies/shell.ts`, `app/academy/layout.tsx`)

**Changes**

1. Notifications: replace the three reads with one query for the top 4 (unread first, then recent) plus one `count(*)` for the unread badge, run in parallel. This removes the **unbounded** unread fetch that is only used for `.length`. Visibility rules stay the same: own rows, plus shared rows from academies where the user has an active membership, with the per-user `notification_reads` join.
2. Get the academy name and logo from the gate's academy row (P2) instead of re-reading `academies`. Fetch email and staff profile in one `users LEFT JOIN staff_profiles` query.
3. Optional and larger: render the notification bell inside a `<Suspense>` boundary, so the layout only waits for the gate before `loading.tsx` streams.

**Expected benefit**
- Items 1 and 2: 11 queries → about 6, and one fewer wave, so the layout goes from about 1.1–1.4 s to about 0.5–0.7 s (**estimate**, assuming P2 is done).
- Item 3: hard-navigation first paint arrives about 1 wave earlier on every `/academy/*` page (**estimate**).

**Risks**
- The unread count must keep matching the inbox exactly, including shared-row read markers.
- The streaming change touches the client shell's props contract.

**Tests:** `lib/notifications/list-notifications.test.ts`; a new test asserting badge count equals the length of the unread list, for owned, shared-read and shared-unread rows; a visual check of the shell.

---

## P4: Remove page waterfalls (parallelize only, no logic changes)

Each page keeps calling the same `lib/` functions with the same arguments. Only the `await` structure changes. Authorization-first ordering is kept where a read's *scope* depends on an earlier result.

| Page | Today (waves, measured warm) | New structure | Expected (**estimate**) |
|---|---|---|---|
| `students/[id]/page.tsx` | 16–17 waves, 4.4–5.2 s | **Stage 1:** `getStudent` (Trainer scope check). **Stage 2:** enrollments, charges, payments, fee history, branches, enroll options, refunds, deletion eligibility in parallel. **Stage 3:** per-enrollment schedule/summary, receipts, refunded amounts, staff labels for payments and refunds, timetable, withdrawals in parallel. | About 7–8 waves, about 2.0–2.5 s now; about 1.4 s with P2 |
| `students/page.tsx` | 12–13 waves, 4.0–4.8 s | Run overview, search, branches and enroll options in parallel. The exception: `?pay=` filters need overview → search, which stays sequential. `canManage` comes from the role already in the gate result. Then courses, payment summaries and photo signing in parallel. | About 6 waves, about 1.8–2.3 s |
| `timetable/page.tsx` | 15 waves, 3.8–4.1 s | `Promise.all` the six independent loads (`listAcademyTimetable`, `listBranches`, `listBatches`, `listCourses`, `listStaff`, academy name) | About 5–6 waves, about 1.3–1.6 s |
| `finance/page.tsx` (payments, charges tabs) | Not measured (about 4 page stages) | Same pattern: run labels, receipts, history and refunded amounts in one parallel stage | About −2 waves (−0.4 s) |
| `id-cards/page.tsx` | Not measured (about 5 stages) | Merge the access check and gate stage; start QR and logo with the lookup | About −1–2 waves |

**Risks**
- More parallelism means more simultaneous queries. The dashboard already queues for 0.9 s on a 10-connection pool. Pair P4 with the query reductions (P2, P3, P5). If pool wait climbs above about 100 ms, raise `max` modestly (15–20) *after* P1, so that cold starts don't multiply.
- Any read that previously ran only after an authorization result must still be safe to run alone. Every `lib/` read already enforces tenant scope itself, so the worst case is wasted work, never a leak. Stage 1 is kept anyway to stay conservative.

**Tests:** existing page E2E specs; for student detail, a Trainer viewing a student outside their batches must still see "Access denied" with no data rendered; harness re-run.

---

## P5: Dashboard query diet (`lib/academies/dashboard.ts`)

**Change:** replace full-report calls that are only used for a few numbers with purpose-built reads. Each one reuses the **same** access helpers as the function it replaces:

| Today | Replacement (same permission check and scope) |
|---|---|
| `getStudentReports`: 8 queries, including branch distribution and enrollment-by-batch, which the dashboard never displays | Total and active counts plus the enrollment trend: 2 queries using the same `resolveScope` |
| `listStaff`: staff rows plus 3 dependency-count queries, to count active staff | `count(*)` of active staff with the same `getViewableStaffProfileIds` rule |
| `listExams`: all exams and results | Count of upcoming exams plus the next exam, with the same `resolveExamAccess` / assigned-batch scope and branch filter |
| `getFinanceReports` (whole report, including income, expenses and refunds) | Only `outstandingCharges` and `paymentsReceived`, through the same visibility gate |

**Expected benefit:** 44 → about 20 queries; the 0.9 s pool wait goes away; about 8 → 5 waves. Warm dashboard goes from 2.7–3.2 s to about 1.2–1.6 s (**estimate**), and further with P2 and P3.

**Risk:** duplicated aggregation logic could drift from the full reports.

**Tests:** for each KPI, an equality test against the full report on the same fixture academy, for each role: owner, admin, manager, finance officer, admissions officer, trainer, and branch-limited roles with the branch filter.

---

## P6: Withdraw / refund dialog actions (`student-overview.tsx`, `course-refunds-actions.ts`, `fee-periods-actions.ts`)

**Changes**

1. Add one read action, e.g. `getWithdrawDialogDataAction(enrollmentId)`. It runs `listFeePeriodsForEnrollment` and `getCourseRefundPosition` in parallel inside **one** request, so auth and the gate run once. The dialog makes one call instead of two serialized ones. The existing actions stay for their other callers.
2. In `generateFeePeriodsForEnrollment`, read the schedule and the existing periods in parallel: they're independent reads, and the generation logic doesn't change.

**Expected benefit:** the dialog goes from about 3.6–4.3 s (two serialized actions, measured individually) to about 1.6–2.0 s now, and about 1.2–1.5 s with P2 (**estimate**).

**Risks:** low; both are reads with unchanged permission checks.

**Tests:** existing `course-refunds.test.ts` and `fee-periods.test.ts`, plus equality of the combined action's result with the two separate actions.

---

## P7: Platform reports SQL aggregation (`lib/subscriptions/reports.ts`)

**Changes**
- `getAcademiesByPlan`: `DISTINCT ON (academy_id) … ORDER BY academy_id, starts_at DESC`, then `GROUP BY` plan name, all in SQL.
- `getRevenueBreakdown`: group in SQL with the **same** bucket keys as `paymentGroupKeyLabel` / `subscriptionGroupKeyLabel`, including their timezone and month semantics. Verify those semantics before porting them.
- `getExpiringSubscriptions`: confirm it is bounded by its date window and limit.

**Expected benefit:** queries that take 1.24 s and 1.75 s (measured) become single small result sets (about 0.21 s, **estimate**). Platform dashboard goes from 2.5–3.2 s to about 1 s.

**Risk:** medium. Revenue bucketing differences, especially around timezones, would misreport finance figures.

**Tests:** `lib/subscriptions/reports.test.ts`, plus before/after equality for every `groupBy` mode on a seeded test branch.

---

## P8: Write-path N+1 in results and exams (needs measurement first)

**Files:** `lib/academies/results.ts:461` (submit) and `:837` (publish), `lib/academies/exams.ts:581` (marks entry).

**Change**
- Bulk `UPDATE … FROM (VALUES …) RETURNING`.
- Bulk insert of approval requests, notifications and audit rows inside the same transaction.
- One `SELECT … FOR UPDATE` for all target rows.

**Expected benefit (estimate, unmeasured):** a 30-student class goes from about 60–120 sequential round-trips (12–25 s, with row locks held throughout) to about 4–6 round-trips (about 1–1.5 s).

**Risks:** high.
- Audit granularity: one row per result must be preserved.
- Approval-request and notification idempotency keys.
- Partial-failure behaviour inside the transaction.
- Lock ordering.

**Prerequisite:** measure the current behaviour on the **test** branch first, by extending the harness to allow writes only when `DATABASE_URL === TEST_DATABASE_URL`.

**Tests:** `results.test.ts` and `exams.test.ts`, plus per-row audit and approval assertions and a concurrency test (two submitters).

---

## P9: Generate-on-read de-duplication (`lib/academies/fee-periods.ts`)

**Change:** keep the lazy generation, which is business behaviour, but stop repeating it within one request:
- Wrap `getScopedEnrollment` and `generateFeePeriodsForEnrollment` in per-request `React.cache()` keyed by enrollment, so student detail's schedule and summary calls share them.
- Optionally move generation out of GET renders into the enrollment and payment mutations. That is a business-logic change, so it's deliberately left for your decision.

**Expected benefit:** about −1–2 waves on student detail (**estimate**).

**Risk:** a cached generate must not hide a concurrent insert. `onConflictDoNothing` already makes duplicate generation harmless.

---

## P10: Indexes (migration approval required; needed for scale, not for today's latency)

Today every table involved has 1,304 rows or fewer, and execution time is under 1 ms. **None of these indexes will make today's pages faster.** Add them when a tenant reaches thousands of students or payments, and verify each one with EXPLAIN ANALYZE on a seeded large test branch first.

| Candidate | Supports | Evidence |
|---|---|---|
| `student_payments (charge_id)`, possibly partial `WHERE status = 'approved'` | Outstanding-charges correlated subquery; charge status recalculation | Seq Scan in the plan; 12,993 seq scans |
| `notifications (user_id, channel, created_at DESC)` | Inbox and bell (owned rows) | Seq Scan notifications in both bell queries |
| `notifications (academy_id, created_at DESC) WHERE user_id IS NULL` | Shared approval notifications | Same |
| `student_charges (academy_id, status)` | Outstanding charges | 31,684 seq scans (small table today) |

---

## P11: Client and browser (low priority)

- **Measure first.** Run a Chrome Performance trace and Lighthouse on a `next build && next start` instance with an authenticated test-branch user, to capture hydration and long tasks. That wasn't measured in this audit.
- `zod` (30 KB gzip) ships only for the auth forms. Consider validating those three forms with plain checks, or loading the schema lazily. Expected gain: about −30 KB gzip on the login pages (measured chunk size). Low risk.

## P12: Developer experience (dev-only)

- Turbopack compiles each route on its first hit: 0.8–1.9 s measured. Do perf testing on `next build && next start`. A dist dir that doesn't collide with dev already exists: `E2E_DIST_DIR=.next-timing`.
- Check the installed Next docs (`node_modules/next/dist/docs`) for Turbopack filesystem caching for dev, to cut recompiles across restarts.
- Optional: commit the read-only harness (currently in the session scratchpad) as `scripts/perf-harness.ts`, so before/after numbers are reproducible. This is a new repo file, so it needs your approval.

---

## Recommended implementation order

| Order | Item | Effort | Risk | Estimated gain (current RTT) | Notes |
|---:|---|---|---|---|---|
| 1 | P0.1 confirm prod region | Decision | n/a | Potentially most of the prod latency | Determines how much the rest matters in production |
| 2 | **P1** pool idle/keepAlive | XS | Low | −1.4 to −5.5 s on the first request after idle (measured delta) | One file, config only |
| 3 | **P4** timetable `Promise.all` | XS | Low | about −2.3 s on timetable | Pure parallelization |
| 4 | **P6** combined dialog action | S | Low | about −1.8 s per withdraw dialog | No permission change |
| 5 | **P2** auth + gate collapse | M | **High** (security) | about −0.4 s on every request and action | Heaviest test burden; highest leverage |
| 6 | **P3** shell consolidation (1, 2) | S–M | Medium | about −0.4 to −0.6 s on every academy page | Builds on P2 |
| 7 | **P4** students and student detail restructuring | M | Medium | −2 to −2.7 s each | Watch pool wait |
| 8 | **P5** dashboard query diet | M | Medium | about −1.5 s, removes queueing | KPI equality tests per role |
| 9 | **P7** platform reports SQL aggregation (+ P0.3 data clean-up) | M | Medium (finance reporting) | about −1.5 to −2 s on the platform dashboard | Equality per `groupBy` |
| 10 | P9 generate-on-read dedup | S | Low–Medium | about −0.2 to −0.4 s on student detail | |
| 11 | **P8** results/exams bulk writes | L | **High** | Possibly tens of seconds on large classes | Measure on the test branch first |
| 12 | P3.3 streaming bell, P10 indexes, P11, P12 | S–M | Low–Medium | Scale and polish | Indexes need approval |

**Combined expectation (estimate, development at today's 207 ms RTT, after items 2–9):**

| Page | Today | After |
|---|---:|---:|
| Dashboard | 2.7–3.2 s warm, 8.5 s cold | about 1.0–1.3 s |
| Students | 4.0–4.8 s | about 1.5–1.8 s |
| Student detail | 4.4–5.2 s | about 1.3–1.6 s |
| Refund-position action | 1.5–1.8 s | about 1.2 s |
| Withdraw dialog | about 4 s | about 1.3 s |

Add dev compile time on top in `next dev`. With P0.1 or P0.2 (co-location or a nearby DB), all of these fall well below 0.5 s, because the same wave counts then cost single-digit milliseconds.

## Cross-cutting testing requirements

1. `npm test` (Vitest, test branch only) and `npm run test:e2e` (Playwright, isolated server on port 3100) must pass after each item.
2. **Tenant isolation:** for every changed read, a user from academy A gets nothing from academy B, including through guessed IDs, which must return the same NOT_FOUND as today.
3. **Role and branch scope:** owner, admin, manager, finance officer, admissions officer, and trainer each see exactly the same rows and KPIs before and after.
4. **Financial equality:** snapshot the outputs of `getStudentPaymentSummaries`, `getOverdueFeeSummary`, `listFeePeriodsForEnrollment`, `getCourseRefundPosition`, `getFinanceReports`, dashboard KPIs and platform revenue on fixed fixtures before the change. After the change they must be identical.
5. **Session security:** revoked and expired sessions are rejected on the very next request; the lazy subscription flip is still persisted and audited exactly once.
6. **Performance regression guard:** re-run the harness and append an "after" column to `PERFORMANCE_BASELINE.md`. Consider query-count assertions in tests (e.g. "dashboard data issues ≤ 22 queries"), so waterfalls can't creep back in.
