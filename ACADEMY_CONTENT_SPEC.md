# Academy Content Specification — Dardar School System

**Purpose**: A page-by-page, field-by-field content specification for the Academy console, built so Claude Design can produce complete, realistic Academy screens with the same depth already achieved for the Platform Console. Every fact below was either read directly from the live application code at `C:\acad\academy` (route files, server actions, Zod schemas, Drizzle schema, permission tables) this session, or is explicitly labeled as a proposed fictional sample value.

**This is a documentation deliverable only.** No application code, schema, server action, permission, or test was changed to produce it.

---

## 1. Scope and Source Hierarchy

Authority order, unchanged this session, per `PLAN.md`'s own "Planning Authority & Source of Truth" section:

1. **`PLAN.md`** — sole authority for data models, server actions, business rules, permissions. Wins on any conflict with any other document.
2. **`DESIGN.md`** — authoritative for UI/UX: screens, navigation, layout, components, states, copy. Defers to `PLAN.md` wherever they overlap on data/business rules.
3. **`PRODUCT.md`** — product scope, positioning, principles.
4. **`CLAUDE_DESIGN_PROMPT.md`** — not an authority. Part A is a generative prompt for fresh mockups; Part B is a verified implementation-handoff synthesis of the three documents above plus direct code reads. This spec treats it the same way: a useful cross-reference, never a source of truth in itself.
5. **The actual application code** (`app/academy/**`, `lib/academies/**`, `lib/auth/academy-permissions.ts`, `lib/db/schema.ts`) — used as evidence of real, shipped behavior. Where code and documents disagree, the documents' authority stands for what the *requirement* is; the code stands for what *currently exists*. Both are reported in §9, never silently resolved.

### Already-established gaps carried into this spec (not re-litigated here; established earlier this session)

- `REQUIREMENTS_GAP_ANALYSIS.md` and `PLANNING_GAPS_RESOLUTION.md` are cited by `PLAN.md`/`DESIGN.md` but do not exist anywhere in this repository.
- `PLAN.md` self-contradicts on password length (8 vs. 12 characters); code and `DESIGN.md` both agree on 8.
- Books, Book Sales, Book Stock, and Fee Periods exist in shipped code and are named only in passing in `PRODUCT.md`'s Operating Context paragraph — this spec is the first document to give them full, detailed coverage (§3.10–§3.11).
- `DESIGN.md`'s documented "teal/violet" seventh status tone for Published/Locked does not exist in the real badge token system — confirmed again, in more depth, in §9 below (only six tones exist anywhere: gray/amber/green/red/blue/slate).
- Self-approval is allowed (not blocked) for Expenses, Results, and Grade Configurations, for the roles named in §5.
- `DESIGN.md`'s mobile table pattern (stacked-card-per-row) is not implemented anywhere; the real `TableWrap` component is horizontal-scroll only, platform-wide.
- The Academy shell's branch/context chip, described in `DESIGN.md` §2.2 as a functional dropdown for academy-wide roles, renders today as a **static label only** — confirmed again in §9 (no list page has a working branch filter wired to it).

### Method

Eight parallel, read-only research passes were run against the real route files, their imports, server actions, Zod schemas, and the Drizzle schema, covering: (1) Students & Admissions, (2) Staff & Branches, (3) Academics (Programs/Courses/Batches/Timetable), (4) Exams & Results & Grade Configurations, (5) Finance (Charges/Payments/Income/Expenses/Fee Periods/Reports/Receipts), (6) Books/Stock/Book Sales, (7) Certificates & ID Cards, (8) Dashboard/Notifications/Reports/Audit Log/Settings. Every claim below is sourced from one of those passes; anything not found in the code is explicitly marked "not found in code read" rather than guessed.

---

## 2. Complete Academy Route Inventory

| # | Route | File(s) | Pattern | Verified access |
|---|---|---|---|---|
| 1 | `/academy` | `page.tsx` | Redirect only → `/academy/dashboard` | Any authenticated member |
| 2 | `/academy/dashboard` | `dashboard/page.tsx` | Custom KPI/alerts dashboard | Any active member (cards hide per-section) |
| 3 | `/academy/students` | `students/page.tsx`, `students-list.tsx` | List + filters | view+ (`academy.students`) |
| 4 | `/academy/students/new` | `students/new/page.tsx`, `student-form.tsx` | Full-page form | full/manage only |
| 5 | `/academy/students/[id]` | `students/[id]/page.tsx`, `student-detail.tsx` | Detail, stacked sections | view+ (Trainer: only their taught-batch students) |
| 6 | `/academy/admissions` | `admissions/page.tsx`, `admissions-list.tsx` | Flat list (not a board — see §9) | Same gate as Students |
| 7 | `/academy/staff` | `staff/page.tsx`, `staff-table.tsx` | List, all mutation controls inline | view+ (`academy.staff`) |
| 8 | `/academy/staff/new` | `staff/new/page.tsx`, `staff-form.tsx` | Full-page form | full/manage only |
| — | **`/academy/staff/[id]` does NOT exist** | — | — | **Confirmed absent — see §9** |
| 9 | `/academy/branches` | `branches/page.tsx`, `branches-list.tsx` | List + inline create + edit dialog | view+ (`academy.branches`) |
| 10 | `/academy/programs` | `programs/page.tsx`, `programs-list.tsx` | List + inline create (no Edit UI — §9) | view+ (`academy.courses_batches`) |
| 11 | `/academy/courses` | `courses/page.tsx`, `courses-list.tsx` | List + create/edit dialog | view+ |
| 12 | `/academy/courses/[id]` | `courses/[id]/page.tsx` | Read-only detail | view+ |
| 13 | `/academy/batches` | `batches/page.tsx`, `batches-list.tsx` | List + create/edit dialog | view+, branch-scoped |
| 14 | `/academy/batches/[batchId]` | `batches/[batchId]/page.tsx`, `roster-panel.tsx` | Detail: trainers + enrolled students | Same scope as parent batch |
| 15 | `/academy/timetable` | `timetable/page.tsx`, `weekly-grid.tsx` | Academy-wide weekly grid + create + manage table | view+, branch-scoped |
| 16 | `/academy/timetable/print` | `timetable/print/page.tsx` | Printable weekly grid | Same as parent |
| 17 | `/academy/exams` | `exams/page.tsx`, `exams-list.tsx` | List + inline mark-entry panel (no separate route) | view+ (`academy.exams`) |
| 18 | `/academy/grades` | `grades/page.tsx`, `grade-configurations-list.tsx` | List + inline bands editor | full/manage (`academy.grade_bands`) |
| 19 | `/academy/results` | `results/page.tsx`, `results-list.tsx` | Grouped-by-exam sections + corrections panel | view+ (dual-gated, see §5) |
| 20 | `/academy/finance` | `finance/page.tsx` | Tabs: Charges/Payments, Income/Expenses | Per-section (3 independent gates) |
| 21 | `/academy/finance/fee-periods` | `finance/fee-periods/page.tsx` | Student picker + schedule + periods | view+ (`academy.fee_periods`) |
| 22 | `/academy/finance-reports` | `finance-reports/page.tsx` | **Pure redirect shim** → `/academy/reports?tab=finance` | N/A — not a real page |
| 23 | `/academy/reports` | `reports/page.tsx` | Tabs: Student/Academic/Finance | Per-tab independent gates |
| 24 | `/academy/receipts/[id]` | `receipts/[id]/page.tsx` | Printable receipt, void-aware | Same as Payments view |
| 25 | `/academy/books` | `books/page.tsx`, `books-manager.tsx` | Catalogue list + create + sell | view+ (`academy.books`) |
| 26 | `/academy/books/stock` | `books/stock/page.tsx`, `stock-manager.tsx` | Read-only inventory view | view+, no mutation controls at all |
| 27 | `/academy/books/sales` | `books/sales/page.tsx`, `book-sales-manager.tsx` | Sales history + payment/refund panels | view+ |
| 28 | `/academy/books/sales/[saleId]/receipt` | `.../receipt/page.tsx` | Printable sale receipt | view+ |
| 29 | `/academy/books/sales/[saleId]/payments/[paymentId]/receipt` | `.../receipt/page.tsx` | Printable single-payment receipt | view+ |
| 30 | `/academy/certificates` | `certificates/page.tsx`, `certificates-list.tsx` | List + issue + cancel + internal verify lookup | view+ (`academy.certificates`) |
| 31 | `/academy/certificates/[certificateId]/print` | `.../print/page.tsx` | Printable certificate | view+ |
| 32 | `/academy/certificates/[certificateId]/pdf` | `.../pdf/route.ts` | Route handler, real PDF download | view+ |
| 33 | `/academy/id-cards` | `id-cards/page.tsx`, `id-card-lookup.tsx` | Lookup + issue + reprint (no list) | manage only (`academy.student_id_cards`) |
| 34 | `/academy/notifications` | `notifications/page.tsx` | Personal inbox | Any authenticated user (not role-gated) |
| 35 | `/academy/audit-logs` | `audit-logs/page.tsx` | Filtered, paginated log | **Owner/Admin only** |
| 36 | `/academy/settings` | `settings/page.tsx` | Profile + logo + usage + notification prefs | full/view_edit (`academy.settings`) |
| 37 | `/verify/[certificateCode]` | `app/verify/[certificateCode]/page.tsx` | Public, unauthenticated | Anyone with the code |

**Shell/system files, not routes**: `app/academy/layout.tsx` (the single access gate for the whole subtree), `template.tsx` (page-transition remount), `error.tsx` (subtree error boundary), `academy-access-message.tsx` (8 reason-keyed blocked-access screens).

**Related account-level screens outside `/academy/*`** (already fully specified in `CLAUDE_DESIGN_PROMPT.md` §B10 items 20–21 from an earlier pass this session, referenced here for completeness, not re-specified): `/account/security`, `/account/activity`, `/account/verify-email`, `/mfa/recovery-codes`.

**Total: 36 real Academy routes + 1 public verification route = 37.** None invented; every row above was confirmed by directly reading its file.

---

## 3. Page-by-Page Content Specification

### 3.1 Dashboard — `/academy/dashboard`

Custom (non-list) layout. Every member sees the page; each card/section independently omits itself (never errors) if the caller's role can't see that data.

**KPI cards** (grid auto-fits, never a fixed 4-column layout):
| Card | Source | Tone | Links to |
|---|---|---|---|
| Total Students | `getStudentReports` | neutral | `/academy/students` |
| Staff | `listStaff().length` | neutral | `/academy/staff` |
| Upcoming Exams | scheduled exams with `examDate >= now` | warning if >0 | `/academy/exams` |
| Pending Approvals | `listPendingApprovalRequests` (Owner/Admin/Manager only) | warning if >0 | no link — spans Grades + Finance |
| Outstanding Charges | `finance.outstandingCharges` | warning/success | `/academy/finance` |
| Payments Collected | `finance.paymentsReceived` | success | `/academy/finance` |

**Alert banners** (color + icon + text): `"{n} item(s) awaiting your approval."` (amber), `"{n} outstanding charge(s)."` (amber, → Finance), `"This academy is at its student allowance limit."` (red, → Settings).

**Sections below the grid**: Recent Payments table (last 10, server-paginated, cols Student/Amount/Date/Method/Status, "View all" → Finance); Enrollment Trend chart (same data source as the Student report, no second query); Usage bars (Students/Staff/Branches/Courses, link "View full usage in Settings →").

**Header**: "Dashboard" / "Overview of your academy performance." / right-aligned literal `"Last updated {weekday}, {time}"` (uncached, server-rendered every request).

**No filters, search, export, or pagination on this page.**

---

### 3.2 Students — `/academy/students`, `/academy/students/new`, `/academy/students/[id]`

#### 3.2.1 Students list (`/academy/students`)

**Columns**: Student (avatar + name + student number, link), Status, Course/Batch (hidden <md), Payment Plan (hidden <xl), Paid/Expected (hidden <lg), Remaining, Payment Status, Phone/Email/Guardian (hidden <xl), Actions.

**Filters** (GET params, server re-render): `q` (name or student number, ILIKE), `status` (active/archived), `branchId` (hidden for branch-limited roles), `page`. Removable filter chips + Clear.

**Pagination**: 15/page, max 100.

**Sort**: `createdAt DESC`, not configurable.

**Row actions**: Record Payment (only if outstanding period exists), Edit, Archive/Restore, Delete (eligibility-gated, disabled-with-tooltip when ineligible, type-exact-name-to-confirm when eligible).

**Edit dialog fields**: photo (separate self-applying upload), `branchId` (academy-wide roles only — rendered as a raw UUID text input, not a dropdown), `fullName`, `dateOfBirth`, `gender`, `phone`, `email`, `guardianName`, `guardianPhone`. **No `status` field** (archive/restore is the only path). **No `profileImageRef` field** (separate upload flow). A separate "Change course" sub-form (batch + payment plan) lives in the same dialog.

**Empty states**: no filters → `"No students yet — register your academy's first student to get started."` + button; filtered → `"No students match your current filters."` + Clear link.

**Role-specific description suffix**: Trainer → "showing students enrolled in the courses or batches you teach."; manage-capable → "you can search, view, and edit students across this academy."; view-only → "you can view every student in this academy (read-only)."

#### 3.2.2 Student registration (`/academy/students/new`)

Gated to full/manage only (Admissions Officer included). Single-column form, groups: Identity / Contact / Guardian / Enrollment (optional).

**Fields**: photo (pre-upload), `branchId` (required, scoped to caller's own branches for Admissions Officer), `fullName` (required), `dateOfBirth`, `gender`, `phone`, `email`, `guardianName`, `guardianPhone`, hidden `profileImageRef`. Enrollment (optional): `batchId` + `paymentPlanIntervalMonths` (1/2/3/4/6/12) + `paymentPlanAmountDollars` (required if a batch is chosen).

**Helper copy**: "A unique student ID (e.g. STD-000123) is generated automatically on save."

**Student ID format**: `STD-000001`, sequential per academy (two academies can both reach `STD-000001`), DB-unique on `(academy_id, student_number)`.

**Success**: "Student registered." → redirect to the new detail page. Partial-success case (enrollment fails after student creation): persistent warning banner, no redirect.

#### 3.2.3 Student detail (`/academy/students/[id]`)

Sections, not literal tabs, each independently gated:
- **Info card** (always, if any view access): avatar, name, status badge, Student #, Phone/Email/DOB/Gender/Guardian.
- **Enrollment & Payment Plan panel** (per active enrollment): schedule line (`"{N} months · {amount}/month · {N} payments"`), stat row (Total/Paid/Remaining/Status), Fee Periods table (Period/Due/Expected/Paid/Remaining/Status/Record-Payment action), a cross-period "catch-up" payment form.
- **One-off Charges panel** (`paymentsSectionVisible`): Description/Amount/Due date/Status table + Create Charge form + Record Payment Against a Charge form.
- **Payment History panel**: merged fee-period + charge payments, one table (Date/Amount/Method/Reference/Notes/Fee period or Charge/Recorded by/Status/Receipt/Reverse-Adjust). Reverse/Adjust gated to Manager only, self-recorded rows disabled with tooltip.

**No ID Card section/tab exists on this page** — confirmed absent (§9).

---

### 3.3 Admissions — `/academy/admissions`

**Not a 3-stage board.** A flat, filtered list showing only `active` students with **zero** active batch enrollments ("Applied"). The moment any enrollment happens, the student disappears from this screen entirely — this is a genuine, extensively self-documented, 2-stage Applied→Enrolled model, not the 3-stage Applied→Documents Pending→Enrolled board `DESIGN.md` §9.2 describes (full detail in §9).

**Columns**: Student, Stage (always "Applied," amber), Registered (relative time), Actions.

**Filters**: Branch only (no search, no status filter).

**Row actions**: "Review" (just a link to `/academy/students?q={studentNumber}` — not a dedicated review screen), "Enroll" (requires `academy.courses_batches` manage, which Admissions Officer does **not** have despite managing students — the Enroll button is absent for them).

**Enroll dialog**: batch select + payment plan + total fee, same `updateStudentEnrollment` action the Students-list course-change dialog uses.

**Empty state**: "No students currently need admissions attention."

---

### 3.4 Staff — `/academy/staff`, `/academy/staff/new`

**No detail page exists.** All editing is fragmented across the list row (§9).

**List columns**: Name, Employee #, Phone, Login email, Role, Status, Actions. **No filters, search, sort, or pagination anywhere.**

**Row controls**: Role (inline `<select>`, owner-grant/demotion requires actor already Owner, last-owner protection enforced), Archive/Restore (status toggle only), Remove access (soft — `academy_memberships.status = "removed"`), Delete (hard, eligibility-gated on zero active membership + zero course/batch/timetable references, type-exact-name-to-confirm).

**Create form** (`/academy/staff/new`): `email` (required), `password` (required only if creating a brand-new user), `fullName`, `phone`, `employeeNumber` (optional), `hireDate` (optional), `role` (default "trainer"). "Create-or-reuse" logic if the email already has a `users` row.

---

### 3.5 Branches — `/academy/branches`

Single page: list + always-visible inline create form + edit dialog + archive/restore/delete. **No separate `/new` route** (unlike Staff).

**Columns**: Name, Code, Status, Address, Phone, Actions.

**Fields**: `name` (required), `code` (required, auto-uppercased server-side), `address` (optional), `phone` (optional). Unique `(academy_id, code)`.

**Archive is unconditional** (no guard against active staff/students, deliberate scope decision). **Restore re-checks the branch allowance.** **Delete** blocked if any student or batch references the branch.

---

### 3.6 Academics — Programs, Courses, Batches, Timetable

#### Programs (`/academy/programs`)
List + inline create. **No Edit UI exists** (schema supports it, no form was wired — §9). Fields: `name` (required), `description` (optional). Archive/Restore + eligibility-gated Delete (blocked if any course attached).

#### Courses (`/academy/courses`, `/academy/courses/[id]`)
List + create/edit dialog. Columns: Image, Name (link, +code), Instructor, Starts, Ends, Status, Actions. Fields: `programId` (required), `name` (required), `code` (optional), `description`, `durationWeeks`, `startDate`/`endDate` (end ≥ start enforced), `imageRef` (upload, JPEG/PNG/WebP/AVIF, 10MB), `instructorId` (optional). **`checkAllowance('courses')` runs inside the create transaction.** Detail page (`[id]`) is read-only: header card + "Enrolled students" table across every batch of the course — explicitly "not an LMS, deliberately no lessons/modules/progress."

#### Batches (`/academy/batches`, `/academy/batches/[batchId]`)
The one entity in Academics that's genuinely branch-scoped. Columns: Name, Course, Code, Start date, Status, Roster link, Actions. Status enum (4 values: `planned/active/completed/archived`) — the UI only ever toggles active↔archived; no control sets `planned`/`completed` (§9). Fields: `branchId`, `courseId`, `name`, `code` (required, unlike Course's optional code), `startDate` (required), `endDate` (optional). Delete blocked by any enrollment/exam/result/certificate (including cancelled certificates — "remain permanently verifiable").

**Batch detail/roster** (`[batchId]`): Trainers section (assign/unassign, reactivates a removed pairing in place on re-assign) + Enrolled Students section (enroll — payment plan is a **required** part of enrollment, "there must never be a successful enrollment without its required initial payment plan" — / withdraw / eligibility-gated delete).

#### Timetable (`/academy/timetable`, `/academy/timetable/print`)
Academy-wide (not per-batch). Weekly grid (rows = distinct time ranges actually present, never a fixed bell schedule; columns = **Saturday-first** day order). Client-side-only filters (Branch/Course/Batch/Instructor/Day), options derived from the already-scoped data so a filter never offers a dead end. Create form: cascading Branch→Course→Batch selects, a **checkbox group** for teaching days (not a single-day picker), start/end time, optional instructor/room. Conflict detection (batch, instructor, room — in that priority order) runs before every insert, with exact per-kind error messages. **No attendance/check-in concept anywhere — explicitly, repeatedly flagged in code as "Decision #21."** This is the only table in the entire Academy area with a genuine hard delete (no status column to soft-delete into).

---

### 3.7 Exams, Mark Entry, Grade Configurations, Results

#### Exams (`/academy/exams`)
List + inline mark-entry panel (no separate route or sub-page for mark entry). Columns: Name, Max marks, Date, Status, Actions. **No filters/search/sort/pagination.** Create form: `batchId`, `name`, `maxMarks` (>0), `examDate` (optional). **Hard precondition**: the academy must have an active grade configuration before any exam can be created. Archive/Restore + Delete (only if the exam has zero results — the one deliberate carve-out from the "archive, never delete" convention elsewhere).

**Mark entry** (inline `MarksEntryPanel`): one table (Student/Status/Marks input), a single "Save marks" button submits every nonblank mark in one all-or-nothing transaction. **There is no separate "Save Draft" control** — "Save marks" is the only action here. Marks must be ≤ the exam's `maxMarks`.

#### Grade Configurations (`/academy/grades`)
List + inline bands editor. Lifecycle: Draft → Pending Approval → Approved → Active (only one Active configuration per academy, atomically swapped). Bands editable only while Draft (label/min/max/pass checkbox, full-replace semantics on save). **No-overlap is enforced at the DB level by a hand-written `EXCLUDE USING gist` migration** that Drizzle's own tooling cannot regenerate or detect — flagged as a real operational risk in §9.

#### Results (`/academy/results`)
Grouped **by exam** into separate sections, not one flat table. Columns: Student, Marks, Status, Grade, Actions. Per-exam bulk actions: "Submit marks for review," "Publish approved results." Per-row actions (Approve/Reject while `under_review`; "Request correction" while `published`). The lifecycle's `submitted` and `rejected` enum values are **never actually persisted** — `submitResults` writes straight to `under_review`, `rejectResult` writes straight back to `draft` (full detail in §9). Publish re-resolves the academy's current active grade configuration at that moment, evaluates each mark against it, and atomically stamps the four "immutable once published" fields.

**Result Correction** (the only path to changing a published value): a modal requiring proposed marks + a reason; re-evaluates against the result's own already-snapshotted grade configuration (not today's active one — a deliberate, reasoned decision); approving it is itself the apply step — no separate "republish" click.

---

### 3.8 Finance — Charges, Payments, Income, Expenses

All on `/academy/finance`, two tab groups: Charges/Payments and Income/Expenses.

#### Charges tab
Columns: Student, Description, Amount, Due date, Status. 15/page. Create form: `studentId`, `description` (required), `amountDollars`, `currency`, `dueDate` (optional). Status (`open`/`partially_paid`/`paid`/`cancelled`) is derived server-side from linked approved payments — **no action anywhere in the code produces `cancelled`** despite the enum value existing (§9).

#### Payments tab
Columns: Student, Course, Amount, Method, Status, Receipt, Reverse/Adjust (Manager only). Payment method is exactly `cash | mobile_money | bank_transfer`. **No approval workflow exists anymore** — every payment is written `status: "approved"` directly and immediately, with the recorder as approver. Create form: `studentId`, optional `chargeId`, `amountDollars`, `currency`, `method` (default cash), `reference`, `notes`, `receivedAt` (required). Receipts: one per payment, issued on demand (not automatic), sequential `RCT-NNNNNN` per academy.

#### Income tab
Columns: Category, Description, Amount, Status, Reverse/Adjust. **No approval step at all** — posts directly to `status: "posted"`. Create form: `category` (required), `description`, `amountDollars`, `currency`. No branch field exposed in the UI despite the schema allowing one.

#### Expenses tab
Columns: Category, Amount, Status, Actions, Reverse/Adjust (general-approve roles only). The **one** entity in Finance that retains an approval workflow: `draft → pending_approval → approved/rejected` (reuses the same `approval_requests` table Grade Configurations use). **Self-approval is explicitly allowed** for Owner, Academy Administrator, Manager, and Finance Officer — confirmed the broadest self-approval allowance in the codebase (Owner and Finance Officer specifically gained it despite never holding general approve authority on anything else).

#### Reversal/Adjustment (identical mechanism across all three entities above)
The original row is flipped to a terminal `"reversed"` status **and nothing else**; a brand-new row is inserted, linked back via a self-FK, born directly `"reversed"` (never re-enters a live/counted status). Self-reversal is unconditionally blocked for every role on every entity — exact message: *"You cannot reverse or adjust a transaction you recorded yourself."* A reason is always required. The permission required to reverse mirrors the permission required to **approve** the entity type, not to create it.

---

### 3.9 Fee Periods — `/academy/finance/fee-periods`

Recurring enrollment-fee installment schedules, structurally distinct from one-off Charges. Flow: student picker → enrollment select → schedule summary + periods table + catch-up payment form.

**Schedule fields**: `intervalMonths` (1/2/3/4/6/12), `amountCents` (the **total** fee, never a per-installment amount — entered as dollars), `anchorDate`. Installments are computed by floor-division with the **last** installment absorbing any rounding remainder, guaranteeing the sum always equals the total exactly.

**Fee period status** (`unpaid/partially_paid/paid/overdue`) is derived live, never stored. "Today" for overdue comparisons is computed server-side in Somalia local time, never the browser clock.

**Schedule-change auto-carry**: if any period has already started or received a payment, changing the schedule automatically carries the remaining balance into the new plan — only the interval is taken fresh from the caller.

**No overpayment support exists anywhere** in fee-period payments, confirmed at both the single-period and the bulk "pay across outstanding periods" level.

---

### 3.10 Books, Stock & Book Sales

**Entirely undocumented in `PLAN.md`/`DESIGN.md`** — this section is the first complete specification of this feature area. Permission: Owner/Admin = view only; Manager/Finance Officer = manage; Admissions/Trainer = no access.

#### Books catalogue (`/academy/books`)
Columns: Cover, Name (+Author), Price, Stock ("Out of stock" in red at 0), Status, Actions. Client-side search only (name/ISBN/author), no pagination. Create form requires a **cover image** (JPEG/PNG/WebP/AVIF, 10MB) — "every newly created book MUST have a cover," though legacy books remain exempt. Row actions: Buy (opens the sell dialog), Deactivate/Activate (no confirmation step), Change cover.

**Sell flow**: buyer is a student (via the shared `StudentPicker`, active students only) or "other person" (name + optional phone); quantity capped at current stock; discount (none/fixed/percentage, server-recomputed, never trusted from the client); amount paid now (0 is valid — records an unpaid/outstanding sale); method (cash or mobile money only — no bank transfer option for book sales). **Stock decrements automatically and transactionally at sale time**, inside a row-locked transaction. Pricing, including the final amount, is always recomputed server-side from the book's current price — never a client-supplied total.

#### Stock (`/academy/books/stock`)
**Pure read — no mutation controls exist on this page at all**, for any role. Columns add "Recent sales (30d)" and a Stock Level filter (All/In stock/Low stock ≤5/Out of stock) — the low-stock threshold is a single fixed, non-configurable constant (5), not per-book or per-academy.

#### Book Sales history (`/academy/books/sales`)
Columns include a "Paid" figure that is actually **net of refunds** (`netPaidCents`), not gross amount paid — a real, undocumented UI nuance flagged in §9. Row actions (manage roles only): Record (additional) payment, Refund, View/Print receipt.

- **Additional payments**: any number of follow-up payments against the same sale, each generating its own receipt, until the remaining balance hits zero — there is no separate "installment plan" schema, just repeat calls to the same action.
- **Refunds**: amount and returned-quantity are independent — a manager can refund money without the buyer returning any copies, or vice versa. **A reason is required.** Refunds restore money via their own dedicated `book_sale_refunds` table (never touching `income_records`, by deliberate design) and restore stock only to the extent a quantity is actually returned. No confirmation dialog beyond the danger-styled "Confirm refund" submit button itself — no "Are you sure?" popup exists.

Receipts are a parallel, purpose-built system (deterministic `BS-{id8}` numbering) rather than reusing the generic academy receipts table, since that table is hard-wired to approved student payments.

---

### 3.11 Certificates & ID Cards

#### Certificates (`/academy/certificates`)
Columns: Student, Program, Batch, Code, Issued, Status, Certificate (View/Print/Download), Actions. **No filters, search, sort, or pagination.** Issue form: Student (active students only) + Batch selects, blocked unless the student has at least one **published, passing** result in that batch (deliberately generic rejection message — never confirms whether *some* results exist at all). Cancel requires a free-text reason and is **terminal** — there is no un-cancel, and deliberately no Delete action exists anywhere on this page. An internal "Verify a certificate" lookup reuses the exact same function the public page calls, rate-limited per staff member instead of per IP.

**Public verification** (`/verify/[certificateCode]`): unauthenticated, zero chrome, exactly 4 fields (student name, program, issue date, status). **Confirmed zero academy-status messaging** — the query never joins against academies or subscriptions at all, so a suspended or closed academy's certificates verify identically to any other. Rate-limited (20 attempts/10 min by default); failed lookups are never logged, to avoid the audit trail itself becoming an enumeration side channel.

#### ID Cards (`/academy/id-cards`)
No search/list UI — takes a pasted student number or id (the student-search page "may not be built yet," per the code's own comment). Issuing a new card always inserts a fresh row (a student can accumulate several real cards over time); reprinting the same card only increments a counter and never changes the card number. **Confirmed: no expiry date is rendered or exists in the schema at all**, despite `DESIGN.md`'s "issue/expiry" wording — a deliberate, documented omission, not an invented value (§9). **No "ID Card" tab/section was found on the Student Detail page** — this is a fully standalone route.

---

### 3.12 Notifications, Reports, Audit Log, Settings

#### Notifications (`/academy/notifications`)
A personal inbox — scoped by `user_id`, not by academy role; any authenticated user reaches it. Read/Unread filter, bulk mark-as-read (capped at 500). 14 fixed, code-defined event templates; two are mandatory (`academy.suspension`, `security.new_device_signin`). **Confirmed gap**: the notification-preferences table exists and is write-enforced, but `enqueueNotification` does not yet consult it — every event is still sent unconditionally regardless of a user's saved toggle.

#### Reports (`/academy/reports`)
Three tabs (Student/Academic/Finance) — **confirmed this structure genuinely matches `DESIGN.md`**. `/academy/finance-reports` is now a pure redirect to the Finance tab, kept only so the two implementations can never drift apart. Each tab has its own filters, KPI cards, and a CSV export (10,000-row cap, every export audit-logged). The Finance tab independently gates each of its three sections (Student Payments/Income/Expenses) — a role invisible on all three sees a clear message rather than a blank or an error, and the file **structurally** never imports the platform-billing tables at all (verified by its own test, not just a runtime filter).

#### Audit Log (`/academy/audit-logs`)
**Confirmed Owner/Admin only**, enforced in three independent places (the permission table itself, the data-layer gate, and nav-item visibility). Hard-scoped to the caller's own academy at the type level — a client-supplied academy filter is not even representable. Columns: When/Actor (resolved real email + role)/Action/Entity/Result. Export CSV includes the full raw row shape (18 columns), not just the 5 on-screen ones.

#### Settings (`/academy/settings`)
Four sections: Academy Profile (name required; `slug`/`defaultCurrency` shown read-only, immutable; saves immediately, no approval step), Logo upload (JPEG/PNG/WebP/AVIF, 10MB, presigned-PUT-then-verify flow), Usage widget (a **cached** snapshot, explicitly informational — real allowance enforcement always recomputes live elsewhere), Notification preferences (one row per template; mandatory ones render as a disabled, always-on, labeled control; optional ones save immediately on toggle).

---

## 4. Form-Field and Validation Inventory

A consolidated reference of every create/edit form found, by entity. (Full per-screen detail is in §3; this table is for quick lookup.)

| Entity | Required fields | Optional fields | Notable validation |
|---|---|---|---|
| Student (register) | branchId, fullName | dateOfBirth, gender, phone, email, guardianName, guardianPhone, photo, enrollment(batch+plan) | Student ID auto-generated; branch must be in caller's scope if Admissions Officer |
| Student (edit) | fullName | branchId (academy-wide only), dateOfBirth, gender, phone, email, guardianName, guardianPhone | No status field here; no profileImageRef here |
| Staff (create) | email, fullName, phone, role | password (if new user), employeeNumber, hireDate | Owner-grant requires actor already Owner |
| Branch | name, code | address, phone | Code auto-uppercased; unique (academyId, code) |
| Program | name | description | Unique (academyId, name); **no Edit form exists** |
| Course | programId, name | code, description, durationWeeks, startDate, endDate, imageRef, instructorId | endDate ≥ startDate; checkAllowance('courses') |
| Batch | branchId, courseId, name, code, startDate | endDate | Unique (academyId, code) |
| Timetable entry | branchId, batchId, daysOfWeek(≥1), startTime, endTime | room, trainerStaffProfileId | HH:MM format; endTime > startTime; conflict-checked |
| Exam | batchId, name, maxMarks(>0) | examDate | Requires an active grade configuration to exist first |
| Mark entry | studentId, marksObtained(≥0) | — | marksObtained ≤ exam.maxMarks |
| Grade configuration | name | — | — |
| Grade band | label, minMark, maxMark, isPass | — | maxMark ≥ minMark; no-overlap (DB-enforced) |
| Student charge | studentId, description, amountDollars | currency, dueDate | — |
| Student payment | studentId, amountDollars, method, receivedAt | chargeId, currency, reference, notes | — |
| Income record | category, amountDollars | description, currency, branchId(schema only) | — |
| Expense record | category, amountDollars | description, currency, branchId(schema only) | Starts as "draft," not live until submitted |
| Fee schedule | enrollmentId, intervalMonths, amountDollars, anchorDate | — | amountDollars is the schedule TOTAL, not per-installment |
| Fee period payment | amount(≤remaining), method, receivedAt | reference, notes | No overpayment allowed |
| Book | name, priceDollars, stockQuantity, coverRef | description, author, isbn, category, currency | Cover required for new books; JPEG/PNG/WebP/AVIF, 10MB |
| Book sale | bookId, buyerType, quantity(≤stock) | studentId/otherBuyerName (one required), discount, amountPaidDollars, method(if paid>0), reference, paidAt | Price always server-recomputed |
| Book sale payment | bookSaleId, amountDollars(≤remaining), method | reference, paidAt | — |
| Book sale refund | bookSaleId, amountDollars(≤refundable), reason | returnedQuantity(≤refundable) | Reason required |
| Certificate issue | studentId, batchId | — | Requires published+pass result in that batch |
| Certificate cancel | reason | — | Required, max 2000 chars; terminal |
| ID card issue | studentId | photoFileRef (URL, not upload) | — |
| Academy settings | name | type, address, phone, email, website, registrationNumber, primaryContactName, primaryContactPhone | email format-validated if present |
| Academy logo | file | — | JPEG/PNG/WebP/AVIF, 10MB |

---

## 5. Permissions and Branch-Scope Matrix

Every Academy-area permission row discovered this session, consolidated. `Full`/`Manage`/`View`/`Approve`/`Enter marks`/`View-Edit` per `getAcademyPermissionLevel`; `—` = no entry, resolves to `none`, action/nav item entirely absent.

| Action row | Owner | Admin | Manager | Admissions | Finance | Trainer |
|---|---|---|---|---|---|---|
| `academy.students` | Full | Full | Manage | Manage | View | View |
| `academy.staff` | Full | Full | Manage | — | — | View |
| `academy.branches` | Full | Full | Manage | View | — | View |
| `academy.courses_batches` | Full | Full | Manage | View | — | Manage* |
| `academy.exams` | Full | Full | Manage | — | — | Enter marks |
| `academy.results` | Approve | Approve | Approve | — | — | — |
| `academy.grade_bands` | Full | Full† | Full | — | — | — |
| `academy.student_payments` | View | Manage‡ | Full | — | Manage | View |
| `academy.income` | View | View | Manage | — | Manage | — |
| `academy.expenses` | Manage§ | Approve | Approve | — | Manage§ | View |
| `academy.fee_periods` | View | Manage | Full | — | Manage | View |
| `academy.books` | View | View | Manage | — | Manage | — |
| `academy.certificates` | Full | Manage | Manage | — | — | View |
| `academy.student_id_cards` | Full | Manage | Manage | Manage | — | — |
| `academy.audit_log` | Full | Full | — | — | — | — |
| `academy.settings` | Full | Full | View-Edit | — | — | — |

\* Trainer reaches "Manage" on `courses_batches` for Batches/Timetable (genuinely branch-scoped) but is explicitly **excluded** from Programs/Courses management despite the matrix cell, since those have no branch scope for it to apply to — a documented judgment call.
† Raised from the originally-planned "Manage" to "Full" in a later, explicitly documented architecture decision so Owner/Admin/Manager are never blocked waiting for a different approver.
‡ Raised from "View" to "Manage" per an in-code-cited "manual student-payment verification report."
§ Owner and Finance Officer hold only "Manage" (create) on Expenses generally, but both are members of `SELF_APPROVE_ROLES` and may approve/reject their own submitted expense immediately — the broadest self-approval allowance found in the codebase.

**Branch scoping, exact and verified (not assumed from role names):**
- **Admissions Officer**: NOT branch-scoped for student *visibility* — sees every student in the academy. Branch-scoped only for (a) which branch they may register a new student into, (b) the branch-transfer field on Edit, (c) Branches/Batches/Timetable visibility.
- **Trainer**: NOT branch-scoped at all for Students/Admissions — scoped instead to students enrolled in batches they are assigned to teach (`batch_trainer_assignments`), a different mechanism from the branch-assignment table. IS branch-scoped (via `staff_branch_assignments`) for Branches/Batches/Timetable.
- All IDOR checks confirmed: an out-of-scope id (wrong academy, wrong branch, wrong trainer-assignment) always returns the identical generic "not found" — never a distinguishing "forbidden."

---

## 6. Workflow and Cross-Page Relationship Maps

**Student registration → enrollment → profile management**
`/academy/students/new` (or Admissions pipeline) → `registerStudent` (auto-generated `STD-NNNNNN` id, `checkAllowance('students')`) → optional immediate enrollment (`enrollStudentInBatch`, which **always** atomically creates a fee schedule — no enrollment can exist without one) → student lands on `/academy/students/[id]` → ongoing: payments recorded directly on the detail page (the "home" of day-to-day payment work) or via `/academy/finance`'s administrative side.

**Course/batch setup → timetable → examination**
`/academy/programs` (create program) → `/academy/courses` (`checkAllowance('courses')`) → `/academy/batches` (branch + course, requires both to exist) → `/academy/batches/[batchId]` (assign trainers, enroll students) → `/academy/timetable` (schedule the batch's sessions, conflict-checked) → `/academy/exams` (requires an active grade configuration to exist first) → mark entry.

**Mark entry → review → approval → publication → correction**
`enterMarks` (draft→marks_entered, all-or-nothing per submission) → `submitResults` (writes straight to `under_review` — "submitted" is never actually persisted) → `approveResult`/`rejectResult` (approved, or straight back to `draft` — "rejected" is never actually persisted) → `publishResults` (requires `approved`; re-evaluates against the academy's grade configuration *active at that moment*; atomically stamps marks/grade/pass-fail/status together) → **only now immutable** → `requestResultCorrection` (the sole path to a further change, re-evaluated against the result's own already-snapshotted configuration, not today's) → approving the correction **is** the apply step, no separate republish click.

**Charge creation → payment recording → receipt generation**
`createStudentCharge` → `recordStudentPayment` (optionally linked to the charge; always posts `approved` immediately) → charge's derived status recalculated in the same transaction → `issueReceipt` (on demand, one per payment, sequential number) → visible on `/academy/receipts/[id]` and included in Finance Reports' "Payments received" card.

**Expense submission → approval**
`createExpenseRecord` (status: `draft`) → `submitExpenseForApproval` (`draft→pending_approval`, creates an `approval_requests` row) → `approveExpense`/`rejectExpense` (general-approve roles decide any row; self-approve-only roles decide only their own submission) → approved expenses appear in Finance Reports' "Expenses" card; a separate "Pending expense approvals" card always shows the live pending count.

**Book management → stock → sales**
`createBook` (cover required) → stock set at creation, adjustable only via `updateBook` (no UI form found wired to this — §9) → `createBookSale` (stock decrements automatically, transactionally, row-locked) → optional `addBookSalePayment` (repeat calls until the balance is zero, each its own receipt) → optional `refundBookSale` (money and returned-stock are independent; reason required) → every payment event (not the full sale amount) posts its own `income_records` row.

**Certificate issuance → public verification**
Published + Pass result exists for `(student, batch)` → `issueCertificate` (DB-unique per student+batch, blocks a duplicate) → printable/PDF views (both disabled once cancelled) → `/verify/[code]` (public, 4 fields, zero academy-status leakage, works identically for a closed academy) → optional `cancelCertificate` (reason required, terminal, never deleted — the cancelled certificate stays permanently, publicly verifiable as cancelled).

**ID-card generation and reprinting**
Staff pastes a student number/id on `/academy/id-cards` → `issueStudentIdCard` (new row, globally-unique card number, no uniqueness constraint on student — a student may accumulate several real cards) → `reprintStudentIdCard` (increments a counter only, card number never changes; the displayed student name is always re-resolved server-side from the card's own record, never trusted from a client-supplied hidden field).

---

## 7. Consistent Fictional Sample Dataset

All names, IDs, and amounts below are **entirely fictional**, invented for this spec, and clearly labeled as such. No real personal or customer data exists anywhere in this product (per `PRODUCT.md`'s own "Evidence on Hand" section — there are no real pilot academies). Every figure below reconciles across the screens that would display it.

**Academy**: Dardar Skills Academy, Hargeisa, Somalia. Default currency: USD.

**Branches**
| Code | Name | Status |
|---|---|---|
| HRG | Hargeisa Main | Active |
| BER | Berbera Branch | Active |

**Staff**
| Name | Role | Branch assignment |
|---|---|---|
| Faadumo Ali | Academy Owner | Academy-wide |
| Khadija Yusuf | Academy Administrator | Academy-wide |
| Omar Said | Manager | Academy-wide |
| Hodan Warsame | Finance Officer | Academy-wide |
| Zahra Abdi | Admissions Officer | Hargeisa Main |
| Ahmed Nur | Trainer | Hargeisa Main (teaches WD101-A) |

**Programs / Courses / Batches**
| Program | Course (code) | Batch (code) | Branch | Status | Trainer |
|---|---|---|---|---|---|
| Information Technology | Web Development Fundamentals (WD101) | WD101-A | Hargeisa Main | Active | Ahmed Nur |
| Business Administration | Digital Marketing Essentials (DM201) | DM201-B | Berbera Branch | Planned | — |

**Grade configuration** — "Standard Grading 2026" (Active):
| Band | Range | Pass? |
|---|---|---|
| A | 90–100 | Yes |
| B | 70–89 | Yes |
| C | 50–69 | Yes |
| F | 0–49 | No |

**Students**
| # | Name | Status | Branch | Enrollment |
|---|---|---|---|---|
| STD-000001 | Amina Hassan | Active | Hargeisa Main | WD101-A, fee plan below |
| STD-000002 | Yusuf Ibrahim | Active | Hargeisa Main | None yet ("Applied" — shows on Admissions) |
| STD-000003 | Sahra Mohamed | Archived | Hargeisa Main | Completed WD101 (prior batch) |

**Amina Hassan's fee schedule** (WD101-A): Total fee $180.00, 6 monthly installments of $30.00 each, anchored to her enrollment date. Two installments paid ($60.00 paid, $120.00 remaining, next due in 11 days — status "Partially Paid" for the schedule, individual periods 1–2 "Paid," period 3 "Overdue," periods 4–6 "Upcoming").

**One-off charge**: "ID card replacement fee" — $5.00, status "Open."

**Exam & result**: "Midterm Exam," WD101-A, max marks 100. Amina scored 78 → Grade "B" → Pass → Published.

**Certificate**: Issued to Amina for WD101-A, code `AB3D-7HKL-9MNP-Q2ST` (format only — a real code is cryptographically random), status "Issued."

**Book**: "Introduction to Web Development" (ISBN 978-0-00-000000-0), author "J. Example," price $15.00, stock 20 (2 sold → 18 remaining). One sale: Amina bought 1 copy for $15.00, paid in full by cash, receipt `BS-A1B2C3D4`.

**Income records**: $60.00 "Book sale: Introduction to Web Development x1" (from the book sale); $60.00 across the two fee-period payments ($30 + $30).

**Expense**: "Classroom supplies — whiteboard markers," $25.00, submitted by Omar Said, approved by Khadija Yusuf, status "Approved."

**Dashboard reconciliation check** (for whoever builds the mockup — these must all agree): Total Students = 3 (2 active + 1 archived, shown per the page's own active/archived split); Payments Collected this period = $120.00 (2× $30 fee-period + $60 book sale, if the same period window); Outstanding Charges = $5.00 (the ID-card fee) + $120.00 remaining fee balance, shown separately since Charges and Fee Periods are different entities; Upcoming Exams = 0 (Midterm already published); Pending Approvals = 1 if Omar's expense is still pending, 0 once Khadija approves it.

---

## 8. Required UI States and Interactions

Consolidated from every screen in §3 (exact copy strings, quoted where found in code):

**Loading**: every list page has a shape-matched skeleton (`ListPageSkeleton columns={N}` for plain tables; bespoke skeletons for Dashboard, Timetable's grid shape, and Results' grouped-by-exam sections).

**Empty states** (icon + one line + action where relevant) — representative examples: Students "No students yet — register your academy's first student to get started."; Admissions "No students currently need admissions attention."; Staff — no bespoke empty copy found, generic table-empty fallback; Branches "No branches to show yet."; Courses "No courses to show yet."; Batches "No batches to show yet."; Exams "No exams yet."; Results "No results yet."; Grade configs "No grade configurations yet."; Charges "No charges to show yet."; Payments "No payments to show yet."; Income "No income records to show yet."; Expenses "No expense records to show yet."; Certificates "No certificates issued yet."; Books "No books to show."; Notifications "No notifications match this filter."

**Error**: `PageMessage` with title "Access unavailable" (subscription/academy-level block) or "Access denied" (role/permission failure) at the page level; inline `ErrorMessage` for form/action failures.

**Success**: toast + often an inline confirmation line, consistently phrased in the past tense ("Student registered.", "Payment recorded.", "Certificate issued.", "Expense submitted for approval.", etc. — exact strings per screen are in §3).

**Confirmation dialogs**: plain `ConfirmButton` for reversible actions (archive/restore); `FormDialog` with a required reason field for one-way actions (cancel certificate, reject result, reverse/adjust a transaction, refund a book sale). Destructive permanent deletes additionally require typing the exact record name. **No action anywhere requires a native browser `confirm()`/`prompt()` — every confirmation is the shared in-app dialog component.**

**Disabled-with-tooltip** (the narrow exception to "absent, not disabled"): self-approval buttons on Grade Configurations ("You can't approve a transaction you recorded."), self-reversal buttons on Finance ("You can't reverse or adjust a payment you recorded yourself."), ineligible permanent-delete menu items across every entity (exact reason text naming the blocking records), disabled Record-Payment/Sell controls when nothing is outstanding/in stock.

---

## 9. Documentation/Code Discrepancies and Unresolved Decisions

Classified exactly as instructed: **Verified in code** / **Documented requirement not implemented** / **Code behavior undocumented in authoritative documents** / **Unresolved product decision**.

### 9.1 Critical — affects how Claude Design should treat the Exam-Result lifecycle

| # | Finding | Classification |
|---|---|---|
| 1 | `DESIGN.md` §1/§3/§9.5 requires a distinct teal/violet "Published/locked" color plus a Stepper component plus a read-only locked banner with a lock icon for published results. **None of this exists anywhere in the codebase** — confirmed by direct grep (zero matches for "Stepper," "locked banner," "teal," "violet" in `app/academy`). Only 6 badge tones exist total (gray/amber/green/red/blue/slate); Published renders with the **identical green tone as Approved** — visually indistinguishable. | **Documented requirement not implemented.** |
| 2 | The result lifecycle's `submitted` and `rejected` enum values exist in the schema but are **never actually written** by any code path — `submitResults` writes straight to `under_review`; `rejectResult` writes straight back to `draft`. The durable record of a rejection lives on the `approval_requests` row, not on `exam_results.status`. | **Code behavior undocumented** (the lifecycle table in `DESIGN.md`/`PLAN.md` names these as real states a reader would expect to see stored). |
| 3 | "Correction Requested" is not a stored `exam_results.status` value — it's derived at read time from a `result_corrections` row. The underlying result stays `"published"` throughout a correction's entire request→decide→apply cycle. | **Code behavior undocumented.** |
| 4 | Self-approval exposure is inconsistent between two screens sharing the identical underlying server-side allowance: Results' UI does not disable Approve/Reject for a submitter's own row (server permits it, so this behaves correctly); Grade Configurations' UI disables with a tooltip for the identical case (server would also permit it there, so the tooltip is stricter than necessary). Not a security bug — both are server-enforced correctly — but a real UI inconsistency. | **Code behavior undocumented** — **also an unresolved product decision**: should both screens disable, or should both allow visibly? |

### 9.2 Staff & Branches

| # | Finding | Classification |
|---|---|---|
| 5 | `DESIGN.md` §9.3 describes a Staff Detail page with tabs (Profile, Role & Permissions, Branch Assignments, Course Assignments, Documents). **No `/academy/staff/[id]` route exists at all.** All editing is fragmented across the list row; there is no "Edit profile" UI of any kind — `fullName`/`phone`/`email`/`employeeNumber`/`hireDate` can only be set once, at creation. | **Documented requirement not implemented.** |
| 6 | A fully built and tested backend for branch assignment (`assignStaffBranches`/`listAssignedBranches`) has **zero UI anywhere** calling it — confirmed by a repo-wide grep. | **Code behavior undocumented** (orphaned backend, no corresponding screen). |
| 7 | The `staffDocuments` table exists in the schema but is permanently unreachable — no upload action exists anywhere in the codebase. | **Documented requirement not implemented.** |
| 8 | No UI exists for viewing/managing a staff member's course assignments — only read-only reference counts (used solely to block deletion). | **Documented requirement not implemented.** |

### 9.3 Admissions & Students

| # | Finding | Classification |
|---|---|---|
| 9 | `DESIGN.md` §9.2 describes a 3-stage board (Applied → Documents Pending → Enrolled). The real screen is a flat 2-stage list (Applied → Enrolled) — extensively, explicitly self-documented in the code's own comments as a deliberate, reasoned correction (the "Documents Pending" stage was never buildable since `student_documents` is dead code — see #10). | **Documented requirement not implemented**, already reconciled in code with full reasoning. |
| 10 | The `student_documents` table exists in the schema but has no upload action/UI anywhere — confirmed dead by the code's own comments. | **Documented requirement not implemented.** |
| 11 | No "ID Card" tab/section exists on the Student Detail page, despite a dedicated permission row (`academy.student_id_cards`) existing for it. ID cards are managed only via the fully separate `/academy/id-cards` route. | **Documented requirement not implemented** (if `DESIGN.md`'s Student Profile "ID Card" tab is read literally). |

### 9.4 Academics

| # | Finding | Classification |
|---|---|---|
| 12 | No Edit UI exists for Programs (Courses has one; the two screens are otherwise parallel). `updateProgram` exists server-side but nothing calls it. | **Code behavior undocumented** (an asymmetry between two otherwise-matched screens). |
| 13 | Batches' 4-value status enum (`planned/active/completed/archived`) is underused by the UI — only active↔archived is ever toggled; no control sets `planned` or `completed`. | **Code behavior undocumented.** |
| 14 | Timetable is the only table in the entire Academy area with a genuine hard delete (no status column exists to soft-delete into) — a deliberate, explicitly flagged exception to the rest of the product's archive-only convention. | **Verified in code**, explicitly reasoned, not a bug. |
| 15 | Timetable's conflict-detection check is a plain `SELECT`, not a DB-level `EXCLUDE` constraint — a true concurrent race could theoretically create two overlapping bookings. Explicitly flagged in code as a deferred follow-up. | **Unresolved product/engineering decision.** |

### 9.5 Exams, Grades

| # | Finding | Classification |
|---|---|---|
| 16 | Grade bands' no-overlap guarantee is enforced only by a hand-written SQL migration (`EXCLUDE USING gist`) that Drizzle's own schema tooling cannot regenerate or detect — the code's own comment warns this constraint's presence should be verified directly against the database, not assumed. | **Unresolved product/engineering decision** (operational risk, not a design gap). |
| 17 | `exams-list.tsx`'s status-color function checks for the string `"marks_entered"` (an `exam_results` value) when it's actually switching on `exam.status` (whose real value is `"marks_entry"`) — a copy-paste mismatch that silently falls through to the wrong (gray) color. | **Code behavior undocumented** (internal bug, not a doc-vs-code gap). |
| 18 | Grade Configurations' page description text still says approval "requires Manager or Owner authority," omitting Academy Administrator, even though Admin was explicitly raised to the identical approve level in a later revision. | **Code behavior undocumented** (stale UI copy). |

### 9.6 Finance

| # | Finding | Classification |
|---|---|---|
| 19 | No `cancelStudentCharge` action exists anywhere in the code, despite the `cancelled` status value existing in the schema and `DESIGN.md`'s copy library naming a cancel pattern generally. | **Documented requirement not implemented.** |
| 20 | The Academy shell's branch/context chip (`DESIGN.md` §2.2) renders as a **static label only** — no list page anywhere has a functional branch filter wired to it. | **Documented requirement not implemented.** |
| 21 | The notification-preferences table is fully built and write-enforced, but `enqueueNotification` does not yet consult it — every event is sent regardless of a user's saved toggle. | **Code behavior undocumented** — explicitly flagged in code as a known, deliberate gap scoped to a later wave. |
| 22 | Finance Reports' branch filter is a free-text field rather than a dropdown, deliberately, so it doesn't gate behind the separate `academy.branches` permission row that Finance Officer — the role this report matters most for — doesn't hold. | **Verified in code**, explicitly reasoned, not a gap. |

### 9.7 Books, Stock & Book Sales (new feature area — see also `CLAUDE_DESIGN_PROMPT.md` §B10 item 19 for the permission-level summary)

| # | Finding | Classification |
|---|---|---|
| 23 | The entire Books/Stock/Book-Sales feature area has zero coverage in `PLAN.md`/`DESIGN.md` — only named in passing in `PRODUCT.md`. This spec (§3.10) is its first full specification. | **Documented requirement not implemented** (the feature itself is real and shipped; the documentation of it is not). |
| 24 | No Edit UI exists for an existing book's name/description/price/stock/category, despite `updateBookSchema` fully supporting it — only Activate/Deactivate and cover-replacement are wired. | **Code behavior undocumented.** |
| 25 | The Book Sales list's "Paid" column actually displays the amount net of refunds, not the gross amount paid — potentially misleading, not accompanied by any explanatory copy. | **Code behavior undocumented.** |
| 26 | Several server error messages for book-sale amount limits interpolate raw cent integers directly into user-facing text (e.g. "...exceeds the final amount (1550 cents)") instead of a formatted dollar amount, inconsistent with the rest of the product's dollar-first money display. | **Code behavior undocumented** (a real, minor inconsistency). |
| 27 | The sell form does not expose a branch field even though the schema accepts one — book sales are therefore effectively unbranched from this UI today. | **Code behavior undocumented.** |

### 9.8 Certificates & ID Cards

| # | Finding | Classification |
|---|---|---|
| 28 | `DESIGN.md`'s "issue/expiry" wording for ID cards is not backed by the schema — `student_id_cards` has no expiry column at all, and none is rendered. Explicitly confirmed as a deliberate, documented omission rather than an invented value. | **Documented requirement not implemented**, already reconciled by the code's own comment. |

### 9.9 Cross-cutting

| # | Finding | Classification |
|---|---|---|
| 29 | The mobile stacked-card-per-row table pattern `DESIGN.md` §2 specifies is not implemented anywhere in the Academy console (or the Platform console, per earlier audits this session) — `TableWrap` is horizontal-scroll only. | **Documented requirement not implemented** (platform-wide, already flagged in `CLAUDE_DESIGN_PROMPT.md`). |

---

## 10. Claude Design Implementation Checklist

Use this before treating any Academy screen as "designed":

- [ ] Every row in §2's 37-route inventory is accounted for — none silently merged, none invented.
- [ ] Staff and Branches are designed as **list-only** screens with all mutation controls inline on the row — not a detail page with tabs, since none exists.
- [ ] Admissions is designed as a **flat, 2-stage filtered list** — not a 3-stage Kanban board.
- [ ] Published exam results get a visually distinct treatment from Approved results — either by first obtaining a product decision resolving finding #1 (§9.1), or by explicitly deferring the distinction and using the same green tone as the rest of the app does today, clearly noted as a known gap rather than silently inventing a teal/violet token.
- [ ] Every status badge anywhere uses only the six real tones (gray/amber/green/red/blue/slate) unless and until a seventh tone is a confirmed product decision.
- [ ] Every list screen without a filter/search/sort/pagination control in §3 is designed that way intentionally — not padded with invented filter chips.
- [ ] Every "Actions" column respects §5's exact role matrix — an absent cell means the control is omitted, never grayed out, except for the specific disabled-with-tooltip cases named in §8.
- [ ] Books, Stock, and Book Sales are designed as three structurally distinct screens (catalogue/sell, read-only inventory, sales-history/payments/refunds) — not merged into one.
- [ ] The fictional dataset in §7 (or an equivalent internally-consistent dataset) is used consistently across every screen that would display the same entity — a student's enrollment, payments, and dashboard totals must agree with each other.
- [ ] Every confirmation dialog for a one-way action names the specific record and the specific consequence (per the exact copy strings quoted in §3/§8) — never a bare "Are you sure?"
- [ ] No screen is treated as already "designed" by Claude Design merely because the component library was synced — per this document's and `CLAUDE_DESIGN_PROMPT.md`'s shared correction, no Academy (or Platform) screen mockups have ever actually been produced by Claude Design; only the real, shipped application and this specification describe what "complete" looks like.

---

## Route coverage summary

- **37 real routes/route-handlers inventoried** (36 under `/academy/*` + 1 public verification page), every one confirmed by directly reading its file.
- **All 37 received full page-by-page specification** in §3 — none deferred.
- **0 routes invented or assumed** — every screen named above was read directly; nothing was inferred from a route name alone.

## Things that could not be verified / remain open

- `/mfa/recovery-codes`'s long-term placement (standalone page vs. an `/account/security` sub-section) — already an open decision from an earlier pass this session, unaffected by this spec.
- Whether a `/academy/staff/[id]` detail page, a `student_documents` upload flow, or an `/academy/students/[id]` ID-Card tab are intended future work or permanently out of scope — none of the four source documents states an intention either way; all are reported as gaps in §9, not resolved here.
- Whether the Books/Fee-Periods permission levels (several roles capped at "view") are final, deliberate decisions or simply never revisited — flagged in `CLAUDE_DESIGN_PROMPT.md` §B10 item 19 already; not re-resolved here.
- Runtime behavior of `/academy/finance-reports/loading.tsx` now that its parent page is a pure redirect — not confirmed either way from static reading alone.
- Whether `app/academy/finance/fee-periods`'s `btree_gist` no-overlap database constraint is actually applied in every real environment — the code's own comment says this must be checked directly against `pg_constraint`, not assumed from the migration file's existence.
