# Performance Audit: Dardar School System

**Date:** 2026-10-29. **Scope:** whole application (Next.js 16.4.2 App Router, React 19.2, Drizzle 0.45 / `pg`, Neon Postgres).
**Companion documents:** `PERFORMANCE_BASELINE.md` (raw measurements and method) and `PERFORMANCE_OPTIMIZATION_PLAN.md` (what to do, in what order).
**No application code, schema, or data was changed by this audit.**

---

## Executive summary

The application isn't slow because of slow SQL. Every hot query executes on the database in **under 1.1 ms** (EXPLAIN ANALYZE).

It's slow because of how many **sequential network round-trips** each request makes, multiplied by a **~207 ms** round-trip to the Neon database in **us-east-2**. On top of that, each new database connection costs **~1.4 s**, and the pool closes idle connections after only 30 s.

| Factor (measured) | Effect |
|---|---|
| Round-trip to Neon (`select 1`, warm) | **207 ms median** |
| New connection (TLS + SCRAM) | **1,400 ms median** |
| Server-side execution of every hot app query | **0.04–1.03 ms** |
| Sequential query "waves" per page | 5 (layout) to 17 (student detail) |
| Total queries per page | 11 (layout) to 52 (student detail) |

This model predicts your observations closely. The refund-position action is 7 waves; the harness measured 1.51–1.76 s against your ~1.7 s. The fee-period action is 9 waves; the harness measured 2.0–2.5 s against your ~2.2 s.

For the page loads, the rest of the gap between harness and browser numbers comes from two sources:
- **Development-only Turbopack compilation:** 0.8–1.9 s per first-visited route, plus 0.25–0.5 s per request in dev.
- **Cold pool reconnects:** the dashboard takes **8.5 s** after 30 s idle vs **2.8–3.0 s** warm.

The 16.9 s dashboard figure fits *cold pool + first-visit compilation + possibly a Neon compute wake-up*. That is an inference, not something reproduced end to end.

**Most important open question:** where is production hosted? If the production app server runs in or next to AWS us-east-2, each round-trip falls to about 1–3 ms. The same 17-wave page then spends well under 100 ms on the database (**estimate**). The per-request structural problems below still matter in that setup, because they multiply any latency. They are also the full explanation of the slowness you see in development.

---

## Phase 1: Architecture inventory

### 1.1 Modules and routes

There are 63 `page.tsx` files, 52 `loading.tsx` files, 2 route handlers (`/api/health`, `/academy/certificates/[certificateId]/pdf`), 48 `"use server"` modules exporting 169 server actions, 85 `"use client"` modules, and 56 Drizzle tables.

| Console | Module | Routes | Data layer (`lib/`) |
|---|---|---|---|
| Academy | Dashboard | `/academy/dashboard` | `academies/dashboard.ts` (fans out to 9 other modules) |
| Academy | Students / admissions | `/academy/students`, `/students/[id]`, `/students/new`, `/admissions` | `students.ts`, `students-overview.ts`, `register-student.ts` |
| Academy | Courses / programs / batches | `/courses`, `/courses/[id]`, `/programs`, `/batches`, `/batches/[batchId]` | `courses.ts`, `programs.ts`, `batches.ts`, `batch-assignments.ts` |
| Academy | Staff / branches | `/staff`, `/staff/new`, `/branches`, `/branches/[branchId]` | `staff.ts`, `branches.ts`, `staff-branch-assignments.ts` |
| Academy | Finance | `/finance` (charges, payments, income, expenses tabs), `/finance/fee-periods`, `/finance-reports`, `/receipts/[id]` | `student-payments.ts`, `fee-periods.ts`, `fee-period-overview.ts`, `finance-reports.ts`, `income-records.ts`, `expense-records.ts`, `finance-reversals.ts` |
| Academy | Refunds | dialogs on student detail | `course-refunds.ts`, `course-refund-rules.ts` |
| Academy | Exams / grades / results | `/exams`, `/exams/[examId]`, `/grades`, `/results` | `exams.ts`, `grade-configurations.ts`, `results.ts`, `result-corrections.ts` |
| Academy | Certificates / ID cards | `/certificates`, `/certificates/[id]/print`, PDF route, `/id-cards`, `/verify/[code]` | `certificates.ts`, `certificate-print.ts`, `id-cards.ts` |
| Academy | Timetable | `/timetable`, `/timetable/print` | `timetables.ts` |
| Academy | Books | `/books` (tabs), sale receipts | `books.ts`, `book-sales.ts`, `book-stock.ts` |
| Academy | Reports | `/reports`, `/finance-reports` | `academic-reports.ts`, `student-reports.ts`, `finance-reports.ts` |
| Academy | Notifications / settings / audit | `/notifications`, `/settings`, `/audit-logs` | `notifications/*`, `settings.ts`, `audit-logs.ts` |
| Platform | Console | `/platform/dashboard`, `academies`, `subscriptions`, `payments`, `plans`, `usage`, `reports`, `staff`, `audit-logs`, `settings` | `platform/dashboard.ts`, `subscriptions/*`, `platform-staff/*` |
| Shared | Auth / account / MFA | `/login`, `/mfa/*`, `/account/*`, password reset | `auth/*` (argon2, sessions, TOTP / email OTP) |

### 1.2 Request pipeline (every authenticated `/academy/*` request)

```
cookie ──► getAuthContext()                         [React cache(), per request]
             ├─ sessions by token_hash               round-trip 1
             └─ platform_memberships by user_id      round-trip 2   (sequential: needs userId)
         ──► checkAcademyAccessForContext()         [React cache(), per request]
             ├─ academy_memberships by user_id       round-trip 3
             └─ academies.closed_at ‖ current sub    round-trip 4   (parallel pair)
             └─ (lazy status flip + audit, rare)     +2
         ──► app/academy/layout.tsx → getAcademyConsoleShellData()
             ├─ academies name/logo ‖ notifications unread (ALL rows) ‖ users.email
             │  ‖ staff_profiles ‖ notifications unread LIMIT 4 ‖ notifications recent LIMIT 4
             └─ (branch-limited roles: staff_profiles → staff_branch_assignments, +2 sequential)
         ──► page.tsx                               (rendered in parallel with the layout)
```

- There is no `proxy.ts`/middleware. That's deliberate (see the `lib/academies/access-gate.ts` header).
- Tenant and branch scoping is enforced in each `lib/` read through `checkAcademyAccessForContext` plus `resolveScope` / `getAssignedBranchIds`.
- `getAuthContext` and `checkAcademyAccessForContext` are wrapped in React `cache()`. The harness confirms they run once per request (`academy_memberships ×1` in most routes).

### 1.3 Caching and revalidation

- There is **no cross-request caching anywhere**: no `use cache`, `unstable_cache`, `revalidate` or `fetch` caching. Every route is dynamic (`ƒ` in the build output). That's appropriate for this multi-tenant, financial application, and this audit doesn't recommend changing it.
- **Mutations** call `revalidatePath(...)`, around 120 call sites, mostly page-scoped. `"/academy/students", "layout"` appears 7 times. A mutation triggered from a page re-renders that page inside the action response. So recording a payment on the student-detail page also pays for a full student-detail render (about 4.4–5.2 s at today's latency; **estimate**, writes weren't executed).
- Redis is used for rate limiting and BullMQ notifications. It plays no part in the read path.

### 1.4 Frontend

- The console shell (`app/_console/console-shell.tsx`) is a client component that receives fully resolved server data. Pages are server components with client islands.
- Heavy libraries are kept off the client: `@react-pdf/renderer` is dynamically imported in the PDF route handler, and `qrcode` is used server-side. The largest avoidable client dependency is **zod (30 KB gzip)**, which only the auth forms use.
- `app/academy/template.tsx` wraps every page in a CSS fade-in, which is cheap.

---

## Phase 2: Database findings

| # | Finding | Evidence | Impact today | Impact at scale |
|---|---|---|---|---|
| D1 | **Round-trip latency dominates; execution doesn't** | RTT 207 ms vs execution ≤1.03 ms on all 15 representative queries | Critical | Critical |
| D2 | **Connection setup 1.3–1.7 s; the pool drops idle connections after 30 s** | `connect` median 1,400 ms; dashboard 8,522 ms cold vs 3,027 ms warm; refund action 4,236 ms vs 1,509 ms | High | High |
| D3 | **Auth + gate is 4 sequential waves on every request and action** | Chain measured at 827–1,028 ms | High | High |
| D4 | **Pool saturation on fan-out pages** | Dashboard sums 911–977 ms of pool wait at `max: 10`; 44 queries in about 8 waves | Medium | Medium |
| D5 | **Duplicate and redundant reads in one request** | Layout reads `notifications` 3×, including an unbounded fetch used only for `.length` (`lib/academies/shell.ts:66`, `unreadNotificationsCount: unread.length`). `academies` is read 2–3× per request (shell, dashboard name, gate). `users.email` and `staff_profiles` are read separately in the shell. | Medium | Medium |
| D6 | **Over-fetching full reports to show a few numbers** | The dashboard calls `getStudentReports` (8 queries, including enrollment-by-batch and branch distribution it never shows), `listStaff` (staff rows + 3 dependency-count queries, only to count active staff), `listExams` (all exams + results, only to count upcoming), and the full `getFinanceReports` | Medium | High |
| D7 | **Unbounded "all rows then aggregate in JS" reads** | `getStudentsOverview` reads every student id in the academy, then passes the whole list as `IN (…)` to 3 more queries (`lib/academies/students-overview.ts`). `getStudentPaymentSummaries` / `getOverdueFeeSummary` aggregate in JS. `listFeePeriodOverview` drops pagination when a status filter is set (`fee-period-overview.ts:92`). Platform `getRevenueBreakdown` / `getAcademiesByPlan` read every subscription. | Low per tenant (≤10 students) | **High**: grows linearly with tenant or platform size |
| D8 | **Platform report queries slow in their own right** | 1,753 ms and 1,236 ms single queries returning about 6k rows (`lib/subscriptions/reports.ts:217,403`) | High (platform console) | High |
| D9 | **Write-path N+1 inside transactions** | Results submit / publish do UPDATE + approval-request insert + notification insert **per result row** (`lib/academies/results.ts:461,837`). Exam marks entry does SELECT … FOR UPDATE + write **per student** (`lib/academies/exams.ts:581`). | **Not measured** (writes not allowed). Estimate: 30 students × 2–4 round-trips × 207 ms ≈ 12–25 s, holding row locks the whole time. | High |
| D10 | **Reads that write** | `listFeePeriodsForEnrollment` and `getEnrollmentPaymentSummary` call `generateFeePeriodsForEnrollment` (2 reads + possible INSERT) on every view (`fee-periods.ts:925,1549`). Student detail does this once per active enrollment, after `getScopedEnrollment` runs twice per enrollment. | Medium (adds 2–3 sequential round-trips) | Medium |
| D11 | **Missing indexes (scale-only)** | `student_payments.charge_id` has no index, so the outstanding-charges correlated subquery seq-scans `student_payments` per charge. `student_payments` has 12,993 seq scans and no `(status)` / `(charge_id)` index. `payment_allocations` has 20,017 seq scans vs 9,217 index scans. `notifications` has no index for shared rows `(academy_id, channel, created_at)` and no `(user_id, channel, created_at)`. `student_charges` has 31,684 seq scans. | None today (tables ≤1,304 rows, execution <1 ms) | Medium–High |
| D12 | **Dev database polluted with leaked test fixtures** | 20k users, 8.3k academies, 8.4k plans, while the largest real-looking academy has 10 students | Inflates every platform-wide query (D8) | n/a |

**Indexes that are already right:** the hot tenant-scoped lookups use them: `students(academy_id)`, `batch_enrollments(academy_id, student_id)`, `fee_periods(academy_id)`, `student_payments(academy_id, created_at)`, `academy_subscriptions(academy_id)`, `sessions(token_hash)` and `academy_memberships(user_id, academy_id)`. **No index is needed to fix today's slowness.**

---

## Phase 3: Next.js and React findings

| # | Finding | Evidence |
|---|---|---|
| N1 | **Page-level waterfalls.** Independent awaits run one after another. | Student detail has 8 sequential stages in `app/academy/students/[id]/page.tsx`: getStudent → photo → enrollments → {fee summaries ‖ charges ‖ payments ‖ fee history} → receipts → refunded amounts → staff labels → {branches ‖ enroll options ‖ gate ‖ timetable ‖ withdrawals ‖ refunds} → refund labels → deletion eligibility. Receipts, refunded amounts and labels only need `payments`; branches, enroll options and deletion eligibility need nothing. Students list: overview → search → branches → {courses ‖ summaries} → photos → enroll options. Overview, search, branches and enroll options are independent. Timetable: **6 independent sequential awaits** (`app/academy/timetable/page.tsx:27-63`). Finance (payments tab): 4 sequential stages. |
| N2 | **The layout blocks first paint on hard navigation.** | `app/academy/layout.tsx` awaits gate + shell data (5 waves, 1.1–1.4 s warm, 3.7–4.0 s cold) before any `loading.tsx` skeleton can stream. The notification preview and badge don't need to block the frame. |
| N3 | **Client-dispatched server actions are serialized.** | Next dispatches one action at a time per client (`node_modules/next/dist/docs/01-app/02-guides/server-actions.md`, "Sequential dispatch on the client"). The withdraw dialog (`app/academy/students/[id]/student-overview.tsx:701-715`) fires `listFeePeriodsForEnrollmentAction` and then `getCourseRefundPositionAction` "in parallel", but they run back to back: about 2.1–2.5 s + 1.5–1.8 s ≈ **3.6–4.3 s** before the dialog is complete. Each action re-runs the full auth + gate chain, and they share the enrollment lookup. |
| N4 | **Mutation responses re-render the current page.** | `revalidatePath` from an action re-renders the calling route inside the action response, so mutation latency = write + full page render (see §1.3). |
| N5 | **Suspense coverage is good, but coarse.** | 52 `loading.tsx` files give instant skeletons on soft navigation. There are no in-page `<Suspense>` boundaries, so a slow secondary panel (e.g. the dashboard's enrollment trend or usage) holds back the whole page. |
| N6 | **Client bundle is moderate and not a bottleneck.** | react-dom 73 KB gzip, Next runtime 45 KB, zod 30 KB (auth pages only), radix about 41 KB. Heavy libraries are server-only. |
| N7 | **Development-only overhead is large but not production behaviour.** | `next dev` adds 0.8–1.9 s per first-visited route, plus 0.25–0.5 s per request. `next start` adds about 50 ms per warm request. |
| N8 | **React request dedup works as intended.** | `getAuthContext` and `checkAcademyAccessForContext` execute once per request. One edge case: `cache()` keys on argument count, so `checkAcademyAccessForContext(ctx)` and `checkAcademyAccessForContext(ctx, undefined)` would be separate entries. The student-detail route shows `academy_memberships ×2`, so worth checking. |

Browser rendering and hydration weren't measured in a real browser (see the baseline, §6). Given about 120 KB gzip of framework JS and server-rendered pages, they're unlikely to rank in the top ten. The plan includes a step to confirm this.

---

## Phase 4: Module-by-module

"Waves" means sequential round-trip waves. Timings are warm, from the harness. "Est." marks values derived from code reading plus the 207 ms RTT model rather than a measurement.

| Module | Route / action | Measured | Queries / waves | Primary cause |
|---|---|---:|---:|---|
| Shared shell | `/academy/*` layout | 1.1–1.4 s (3.7–4.0 s cold) | 11 / 5 | Auth + gate chain (4 waves) + shell fan-out; notifications ×3 |
| Academy dashboard | `/academy/dashboard` | 2.7–3.2 s; 8.5 s cold | 44 / 7–8 + 0.9 s pool wait | Over-fetch (D6), fan-out beyond pool size (D4), cold pool (D2) |
| Students | `/academy/students` | 4.0–4.8 s | 48 / 12–13 | Page waterfall (N1), whole-academy overview (D7), dependent counts |
| Student details | `/academy/students/[id]` | 4.4–5.2 s | 52 / 16–17 | 8-stage page waterfall (N1), per-enrollment generate-on-read (D10) |
| Fee periods | `listFeePeriodsForEnrollmentAction` | 2.0–2.5 s | 10 / 9 | Auth chain + scoped enrollment + generate-on-read + paid-sum, all sequential |
| Refunds | `getCourseRefundPositionAction` | 1.5–1.8 s (4.2 s cold) | 9 / 7 | Auth chain + enrollment + shares; serialized behind the fee-period action in the dialog (N3) |
| Fee-period overview | `/academy/finance/fee-periods` | 2.1–2.3 s | 17 / 9 | Layout chain + overview → photos waterfall; unpaged when status-filtered (D7) |
| Timetable | `/academy/timetable` | 3.8–4.1 s | 30 / 15 | 6 independent sequential awaits; `listStaff` dependency counts |
| Platform dashboard | `/platform/dashboard` | 2.5–3.2 s | 15 / 3 | Two 1.2–1.8 s whole-table report queries (D8), bloated dev data (D12) |
| Finance | `/academy/finance` | Est. 3–4 s | Est. 4 page stages + layout | Same waterfall pattern as students (search, charges, overview, labels) |
| ID cards | `/academy/id-cards` | Est. 3–4 s | Est. 5 stages | Access check → gate → card → 5-way parallel → QR / logo |
| Batches / courses / exams / grades / staff / branches | list and detail pages | Est. 1.5–2.5 s | 3–4 stages | Mostly layout + one list call. `listStaff` adds a dependency-count wave; `listExams` filters in JS |
| Reports | `/academy/reports`, `/finance-reports` | Est. 2–3 s | Grouped aggregates | Correctly SQL-aggregated; cost is waves, not data |
| Certificates | list, print, PDF | Est. 1.5–2.5 s | n/a | PDF rendering is server-side and CPU-bound (`@react-pdf`); not measured |
| Notifications | shell + `/academy/notifications` | Part of the layout | 3 queries per request | Unbounded unread fetch for the badge count |
| Settings / audit logs | `/academy/settings`, `/audit-logs` | Est. 1.5–2 s | n/a | Layout + 1–2 waves; audit list is paged |
| Auth | login / MFA | Not measured | n/a | argon2 hashing is intentionally slow (security), plus rate-limit Redis calls. Out of scope. |
| Results / exams (writes) | submit, publish, marks entry | **Not measured** | O(students) waves in one transaction | Write-path N+1 (D9) |

---

## Phase 5: Ten biggest bottlenecks (ranked)

**Layers:** DB = database execution, Net = network and request overhead, App = server application processing, Dev = development compilation only. "Est." marks figures that weren't measured.

| Rank | Module | Route / action | Measured duration | Root cause | Layer | Severity | Recommended fix |
|---:|---|---|---:|---|---|---|---|
| 1 | All | Every request and action | 207 ms per round-trip × 5–17 waves | App server is about 200 ms from Neon us-east-2; SQL execution itself is <1.1 ms | Net | **Critical** | Co-locate the production app with the DB region. For dev, use a closer Neon region or local Postgres. Reduce waves (ranks 3–9). |
| 2 | All | First request after >30 s idle | +1.3–1.7 s per new connection; dashboard 8.5 s vs 2.8–3.0 s warm | `idleTimeoutMillis: 30_000` closes the pool; each reconnect needs TLS + SCRAM channel binding | Net | **High** | Keep connections longer (`idleTimeoutMillis` of a few minutes, `keepAlive: true`); evaluate Neon's pooled endpoint |
| 3 | Shared | Auth + gate (every page and action) | 0.83–1.03 s | 4 dependent sequential lookups | Net / DB | **High** | Collapse into 2 queries (session⋈platform role; membership⋈academy⋈latest subscription) with identical checks |
| 4 | Shared | `/academy/*` layout | 1.1–1.4 s warm, 3.7–4.0 s cold; blocks first paint | Gate chain + shell fan-out; notifications read 3× incl. unbounded; duplicate academy and user reads | Net / App | **High** | One notifications query (count + top 4); merge profile and email; stream the bell via `<Suspense>` |
| 5 | Students | `/academy/students/[id]` | 4.4–5.2 s | 8-stage page waterfall; generate-on-read per enrollment; duplicate scoped-enrollment reads | Net / App | **High** | Restructure into about 3 parallel stages; one batched summary read for all enrollments |
| 6 | Students | `/academy/students` | 4.0–4.8 s | 6-stage waterfall; whole-academy overview fed as IN lists | Net / App | **High** | Run overview / search / branches / enroll options in parallel; SQL-side overview aggregates |
| 7 | Timetable | `/academy/timetable` | 3.8–4.1 s | 6 independent awaits run sequentially; `listStaff` dependency counts | Net / App | **High** | `Promise.all` the independent loads; a staff-lite read without dependency counts |
| 8 | Dashboard | `/academy/dashboard` | 2.7–3.2 s warm, 8.5 s cold (+ dev compile; your 16.9 s) | Full reports fetched for a few KPIs (44 queries); 0.9 s pool queueing; cold pool | Net / App / Dev | **High** | Purpose-built count / sum queries; trims the fan-out below pool size |
| 9 | Fee periods + refunds | Withdraw dialog actions | 2.0–2.5 s + 1.5–1.8 s, **serialized**: ≈3.6–4.3 s | Each action = full auth chain + sequential reads + generate-on-read; Next serializes client actions | Net / App | **High** | One combined read action for the dialog; collapse the chains (rank 3) |
| 10 | Platform | `/platform/dashboard` and `/platform/reports` | 2.5–3.2 s; single queries 1.24 s and 1.75 s | Whole-table subscription reads aggregated in JS; inflated by 8k leaked fixture academies | DB / Net | **High** (platform staff) | `GROUP BY` / `DISTINCT ON` in SQL; clean leaked fixtures from dev |

**Just outside the top ten:**
- **Write-path N+1 in results and exams (D9):** potentially the slowest single interactions in the app, but writes couldn't be measured.
- **Dev-only Turbopack compile:** 0.8–1.9 s per route.
- **Generate-on-read (D10).**
- **Scale-only index gaps (D11).**

---

## Phase 6: Recommendations at a glance

The full plan, with expected benefits, risks and tests, is in `PERFORMANCE_OPTIMIZATION_PLAN.md`. Guiding constraints applied throughout:

- No cross-request caching of anything that is user-, tenant- or finance-specific. All recommendations are per-request deduplication, fewer round-trips, or SQL-side aggregation, so results stay exactly as fresh as today.
- Session revocation and expiry are still checked on every request. The access gate's closure → membership → subscription → lazy-flip semantics stay identical.
- Balance, refund and overdue maths aren't rewritten. Where aggregation moves into SQL, the plan requires before/after equality tests on the same fixtures.
- Index and schema changes are listed separately and need your approval (migrations).
