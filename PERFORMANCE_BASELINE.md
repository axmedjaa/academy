# Performance Baseline: Dardar School System

Measured 2026-10-29 on the developer workstation, against the Neon **development** branch (`DATABASE_URL`). No data was modified (see the method section). These are the "before" numbers that every optimization in `PERFORMANCE_OPTIMIZATION_PLAN.md` should be re-measured against.

## 1. Environment

| Item | Value |
|---|---|
| Next.js | 16.4.2 (Turbopack), React 19.2.8 |
| ORM / driver | drizzle-orm 0.45 over `pg` `Pool` (`lib/db/index.ts`: `max: 10`, `idleTimeoutMillis: 30_000`) |
| Database | Neon Postgres, **us-east-2**, direct endpoint (not `-pooler`), `sslmode=verify-full`, `channel_binding=require` |
| App server for these measurements | Developer workstation (same network path as `next dev`) |
| Representative tenant | The academy with the most active enrollments, acting as its `academy_owner` |

### Dev database shape (pg_stat_user_tables, live rows)

| Table | Rows | Note |
|---|---:|---|
| users | 20,467 | Mostly leaked test fixtures (see `lib/testing/require-test-database.ts` header) |
| subscription_plans | 8,385 | Same |
| academies | 8,281 | Same |
| academy_subscriptions | 5,957 | Same |
| students | 3,682 | Spread over thousands of fixture academies |
| **Largest single academy** | **10 students, 12 enrollments, 19 fee periods, 12 payments** | Per-tenant data volume is tiny |

**Consequence:** this database can't show per-tenant scaling problems. It does reproduce platform-wide problems, because the platform console scans all academies.

## 2. Network and connection cost (measured)

| Measurement | min | median | max |
|---|---:|---:|---:|
| New connection (TCP + TLS + SCRAM auth), 5 samples | 1,294 ms | **1,400 ms** | 1,715 ms |
| `select 1` round-trip on a warm connection, 20 samples | 206 ms | **207 ms** | 307 ms |
| Auth + access-gate chain (4 sequential queries) | 827 ms | **911 ms** | 1,028 ms |

## 3. Server-side SQL execution (EXPLAIN ANALYZE, representative tenant)

Every hot read query executes on the server in **under 1.1 ms**. The time seen by the app is the network round-trip.

| Query (as issued by the app) | Execution | Planning | Wall time seen by client | Plan |
|---|---:|---:|---:|---|
| Notifications unread (shell badge, no LIMIT) | 0.21 ms | 0.41 ms | 208 ms | Seq Scan notifications + Seq Scan notification_reads |
| Notifications recent, LIMIT 4 | 0.21 ms | 0.23 ms | 289 ms | same |
| Current subscription | 0.04 ms | 0.12 ms | 305 ms | Index Scan `academy_subscriptions_academy_id_idx` |
| Students page rows (LIMIT 25) | 0.05 ms | 0.21 ms | 248 ms | Bitmap `students_academy_id_idx` |
| Students page count | 0.06 ms | 0.07 ms | 208 ms | Bitmap `students_academy_id_idx` |
| Students overview (all ids) | 0.05 ms | 0.06 ms | 208 ms | Bitmap `students_academy_id_idx` |
| Student search ILIKE | 0.06 ms | 0.15 ms | 210 ms | Bitmap + filter |
| Active enrollments for N students (IN list) | 0.05 ms | 0.12 ms | 210 ms | Index `batch_enrollments_academy_id_student_id_idx` |
| Fee periods for N enrollments | 0.05 ms | 0.14 ms | 208 ms | Bitmap on unique (enrollment_id, …) |
| Approved paid cents by period | 0.26 ms | 0.39 ms | 210 ms | Hash Join, **Seq Scan student_payments (701 rows)** |
| Overdue fee summary | 0.09 ms | 0.65 ms | 210 ms | Index scans |
| Recent student payments (LIMIT 5) | 0.04 ms | 0.20 ms | 220 ms | Index `student_payments_academy_id_created_at_idx` |
| Outstanding charges (correlated paid subquery) | 0.06 ms | 0.20 ms | 208 ms | **Seq Scan student_payments per charge** |
| Audit log page (LIMIT 50) | 0.13 ms | 1.03 ms | 209 ms | Seq Scan audit_logs (134 rows) |

The only queries found that are slow in their own right are on the platform console:

| Query | Measured duration | Cause |
|---|---:|---|
| `getRevenueBreakdown` subscriptions read (`lib/subscriptions/reports.ts:403`) | **1,753 ms** | Returns every non-cancelled subscription (≈6k rows with joins) across the WAN; aggregated in JS |
| `getAcademiesByPlan` (`lib/subscriptions/reports.ts:217`) | **1,236 ms** | Returns every subscription of every open academy; deduplicated and counted in JS |
| `getExpiringSubscriptions` | 488 ms | Wide join over all subscriptions |

## 4. Route and action timings (read-only harness)

**Columns:**
- **Queries:** number of SQL statements per request.
- **Depth:** approximate count of non-overlapping query "waves". It undercounts when the pool queues work.
- **Warm:** median of runs on an already-open pool.
- **First:** run 1, opening new connections.
- **Pool wait:** summed time queries spent waiting for a free pooled connection (warm run).

| Route / action | Queries | Depth | First (cold-ish) | Warm | Pool wait | Your observation |
|---|---:|---:|---:|---:|---:|---:|
| `/academy/*` layout alone (auth + gate + console shell) | 11 | 5 | 3,749–3,978 ms | **1,115–1,380 ms** | ≤33 ms | n/a |
| `GET /academy/dashboard` (layout ‖ page) | 44 | 7–8 | 4,785–5,015 ms | **2,673–2,959 ms** | **911–977 ms** | 16.9 s |
| `GET /academy/dashboard` after **>30 s idle** (pool fully closed) | 44 | 9 | **8,522 ms** (10 new conns) | 3,027 ms | n/a | n/a |
| `GET /academy/students` | 48 | 12–13 | 4,231–4,412 ms | **4,015–4,787 ms** | 56 ms | 6.4 s |
| `GET /academy/students/[id]` | 52 | 16–17 | 4,344–4,989 ms | **4,388–5,204 ms** | ~100 ms | 8.6 s |
| `GET /academy/timetable` | 30 | 15 | 3,685–3,968 ms | **3,801–4,103 ms** | 34–39 ms | n/a |
| `GET /academy/finance/fee-periods` | 17 | 9 | 2,235–2,245 ms | **2,084–2,341 ms** | 56 ms | n/a |
| `GET /platform/dashboard` (layout ‖ page) | 15 | 3 | 4,001–4,279 ms | **2,548–3,212 ms** | 74–157 ms | n/a |
| Action `listFeePeriodsForEnrollmentAction` | 10 | 9 | 1,985–2,643 ms | **2,108–2,477 ms** | 2 ms | ≈2.2 s |
| Action `getCourseRefundPositionAction` | 9 | 7 | 1,536–1,706 ms | **1,509–1,764 ms** | 3 ms | ≈1.7 s |
| Action `getCourseRefundPositionAction` after >30 s idle | 9 | 7 | **4,236 ms** (2 new conns) | n/a | n/a | n/a |

Ranges are across three harness runs. The two server actions match your observations within about 10%, which supports the model below.

### Pool-size A/B (same harness, `max` injected via the existing `globalThis.__dbPool` hook)

| Route | `max: 10` warm | `max: 30` warm | `max: 30` first run |
|---|---:|---:|---:|
| Dashboard | 2,959 ms | 2,439 ms | 5,953 ms (14 new connections) |
| Students | 4,787 ms | 4,312 ms | 4,173 ms |
| Student detail | 5,068 ms | 5,047 ms | 6,621 ms |
| Fee-period action | 2,452 ms | 2,152 ms | n/a |
| Refund-position action | 1,739 ms | 1,670 ms | n/a |

A larger pool removes the dashboard's queueing (about 0.5 s) but makes cold starts worse. Pool size isn't the main cause.

### Queries per table in one request (duplicates highlighted)

| Route | Repeated reads |
|---|---|
| Layout | `notifications` ×3 (unread-all for the badge count, unread LIMIT 4, recent LIMIT 4), `academies` ×2 |
| Dashboard | `students` ×4, `student_payments` ×4, `batch_enrollments` ×4, `academies` ×3, `notifications` ×3, `academy_subscriptions` ×2, `staff_profiles` ×2, `expense_records` ×2 |
| Students | `batch_enrollments` ×6, `students` ×5, `fee_periods` ×3, `payment_allocations` ×3, `certificates` ×3, `batches` ×3 |
| Student detail | `students` ×5, `batch_enrollments` ×5, `batches` ×3, `certificates` ×3, `academy_memberships` ×2, `users` ×2 |

## 5. Framework overhead: development vs production

| Request (unauthenticated → 307 to /login, **no DB query**) | `next dev` first hit | `next dev` repeat | `next start` first hit | `next start` repeat |
|---|---:|---:|---:|---:|
| `/academy/timetable/print` | 2.29 s | 0.46 s | 0.84 s | 0.066 s |
| `/academy/finance-reports` | 2.34 s | 0.45 s | n/a | n/a |
| `/academy/certificates` | 1.26 s | 0.26 s | n/a | n/a |
| `/academy/dashboard` | n/a | n/a | 0.54 s | 0.052 s |
| `/platform/usage` | 1.31 s | 0.52 s | 0.084 s | 0.048 s |

- **Dev-only cost:** about 0.8–1.9 s of Turbopack compilation on the first hit of each route, plus about 0.25–0.5 s per request even when the page does nothing. Your dev log shows `○ Compiling /academy/dashboard ...` at the start of the session in which the 16.9 s was observed.
- **Production cost:** about 50 ms of framework overhead per warm request, plus a one-time module load of about 0.5–0.8 s per route per server process.

## 6. Client bundle (production build into `.next-timing/`)

| Chunk | Raw | Gzip | Contents |
|---|---:|---:|---|
| `0z0uaibo0pg76.js` | 235 KB | 73 KB | react-dom |
| `0l2lq3ivah1l7.js` | 165 KB | 45 KB | Next.js client runtime |
| `0cz1d0mv5g_q7.js` | 113 KB | 39 KB | App/shared client code |
| `43am6-nr2ogwk.js` | 105 KB | 30 KB | **zod**, from client-side validation on `/login`, `/forgot-password`, `/reset-password` (`lib/validation/use-field-errors.ts`) |
| `09usfr2x10-yc.js` / `0abcc0p8emqhr.js` | 71 / 58 KB | 22 / 19 KB | radix-ui |
| All client chunks | 2.4 MB raw total across all routes | n/a | n/a |

There are 85 `"use client"` modules. `@react-pdf/renderer` and `qrcode` stay server-side; `@react-pdf/renderer` is dynamically imported in the PDF route handler. **Browser rendering and hydration were not measured in a browser**, because that needs an authenticated session (a session-row write). See the plan for how to capture it.

## 7. How the numbers were produced

All scripts are in the session scratchpad, not the repo:

- `measure.mjs`: connection, RTT, table stats, EXPLAIN ANALYZE, and the index inventory. Runs inside `BEGIN READ ONLY … ROLLBACK`.
- `harness.ts`: calls the same `lib/` data functions each route calls, in the same order and concurrency. Layout and page run concurrently, because Next renders segments in parallel (`node_modules/next/dist/docs/01-app/01-getting-started/06-fetching-data.md:460`). React's per-request `cache()` is emulated by installing a cache dispatcher on React's server internals. It runs under `PGOPTIONS='-c default_transaction_read_only=on'`, so any write attempt throws instead of executing. pg `Client.query`, `Pool.query` and `Client.connect` are instrumented for counts, timing, overlap (depth) and pool wait.
- The session lookup uses a non-matching token hash: same index probe, same round-trip, no session row needed.

**Not captured by the harness:** RSC serialization and HTML render (production overhead measured at about 50 ms, §5), browser hydration, and Neon compute auto-suspend wake-up. The `lib/db/index.ts` comment notes Neon free tier suspends after 5 min idle; not measured here.

Re-run, from the repo root:

```sh
PGOPTIONS='-c default_transaction_read_only=on' node --conditions=react-server --env-file=.env.local --import=tsx <scratchpad>/harness.ts
```

Optional environment variables: `POOL_MAX=<n>`, `EXTRA=1` (platform dashboard, timetable, fee-periods), `SLOW=1` (top queries), `DUPS=1` (per-table counts).

---

## 8. After the optimizations (P1–P9, measured 2026-10-30)

Same harness, same dev branch, same fixture, read-only. Warm medians.

- "Original" is §4 above (2026-10-29).
- "Before P4–P9" was measured on 2026-10-30 after P1–P3 had shipped.
- "After" is with every item in `PERFORMANCE_OPTIMIZATION_PLAN.md` §Status applied.

| Route / action | Original | Before P4–P9 | After | Change vs original |
|---|---:|---:|---:|---:|
| `/academy/*` layout (auth + gate + shell) | 1,115–1,380 ms (11 queries) | 653 ms (5) | ≈650 ms (5) | −45% |
| `GET /academy/dashboard` | 2,673–2,959 ms (44 queries, 0.9 s pool wait) | 2,162 ms (38) | **1,728 ms (23, 43 ms pool wait)** | −38% |
| `GET /academy/dashboard` after >30 s idle | 8,522 ms | 2,133 ms (no reconnect) | n/a | −75% |
| `GET /academy/students` | 4,015–4,787 ms (48) | 3,478 ms (42) | **1,929 ms (42, 6 waves)** | −56% |
| `GET /academy/students/[id]` | 4,388–5,204 ms (52) | 3,908 ms (46) | **2,181 ms (46, 6 waves)** | −53% |
| `GET /academy/timetable` | 3,801–4,103 ms (30) | 3,043 ms (24) | **1,089 ms (20, 3 waves)** | −72% |
| `GET /academy/finance/fee-periods` | 2,084–2,341 ms | 1,539 ms | 1,526 ms | −30% (P2/P3 only) |
| `GET /platform/dashboard` | 2,548–3,212 ms | 2,211 ms | **1,533 ms** | −46% |
| Action `listFeePeriodsForEnrollment` | 2,108–2,477 ms (10) | 1,520 ms (7) | **1,284 ms (7, 6 waves)** | −44% |
| Action `getCourseRefundPosition` | 1,509–1,764 ms (9) | 1,076 ms (6) | 1,071 ms (6) | −34% |
| Withdraw dialog (both reads) | ≈3.6–4.3 s (2 serialized actions) | 2,354 ms | **1,279 ms (1 action)** | −68% |

### Write paths (test branch, one 30-student exam, git-HEAD code vs current)

| Operation | Before | After | Outcome check |
|---|---:|---:|---|
| `enterMarks` (30 entries) | 13,831 ms | **2,469 ms** | Identical: 30 rows `marks_entered` |
| `submitResults` (30 results) | 46,554 ms | **12,123 ms** | Identical: 30 under review, 30 pending approval requests |
| `publishResults` (30 results) | 38,766 ms | **11,100 ms** | Identical: 30 published, same band split (A 7, B 6, C 11, F 6) |

Most of the remaining submit and publish time is one notification per result (three DB round-trips plus a Redis call each). They are now enqueued four at a time instead of one after another.
