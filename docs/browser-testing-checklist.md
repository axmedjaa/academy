# Browser testing checklist — Books, enrollment, batches, permissions

For release `bf1f3eb` (Books orders and Reports, program enrollment, batch
status, staff roles). Tick each box; next to any failure write the page, the
role, what you saw and any console error.

**Status (2026-11-16):** production deployed and healthy (`/api/health` ok).
The owner reviewed the live pages and reported them OK; the individual
checks below have not yet been ticked one by one.

## Before you start

- **Where:** the live site (`https://hirgal.dardar.cc`) or `npm run dev`.
  Both use the same shared database, so everything you create is real data.
- **Test data only:** use a test academy, or clearly named test records
  ("TEST Buyer", "TEST Student", a "TEST" batch with no real students) and
  tiny amounts (for example 0.50). Payments can't be deleted, only
  reversed. Never Archive, Withdraw or Cancel real records.
- **Accounts:** Academy Owner, Administrator, Manager and Trainer in the
  test academy, plus one user of a second academy (isolation checks).
  The Admissions Officer and Finance Officer roles were retired (migration
  0044) and can no longer be assigned.
- **Console:** DevTools → Console, filtered to Errors, open on every page.
- **Desktop pass:** window ≥ 1280 px, sections in order (later sections use
  records made earlier).
- **Mobile pass:** DevTools device toolbar at 390 × 844. Per section open
  the main list, open one dialog and submit it. No horizontal page scroll,
  dialogs fit and scroll, buttons ≥ 44 px, tables become stacked cards.

Key URLs: `/academy/books`, `/academy/books/orders`, `/academy/books/orders/<id>`,
`/academy/books/payments`, `/academy/books/distribution` (Give Books),
`/academy/books/reports`, `/academy/finance`, `/academy/reports`,
`/academy/students`, `/academy/students/<id>`, `/academy/admissions`,
`/academy/batches`, `/academy/batches/<id>`.

## 1. Books — layout and Create Order (Owner)

- [ ] Tabs read **Books · Orders** on the left and **Reports** at the right end with a chart icon.
- [ ] The hero offers **Add Book, Create Order, Give Books, Reports**.
- [ ] Books tab is unchanged: **Books / Stock / Sell**; Add Book and Sell Book work as before.
- [ ] Orders tab pills: **Orders / Payments / Give Books**. No supplier page, button or wording anywhere.
- [ ] **Create Order** first asks **Who is buying these books?** (Student / Other buyer); **Change** goes back.
- [ ] Student: search by name, number or phone; the card shows name, student ID, branch, phone. Only this academy's (and your branches') students appear.
- [ ] Other buyer: full name required; phone and email optional; a bad email is refused; branch asked only when you have several.
- [ ] Two books with quantities: line totals, subtotal, discount, total, paid now and balance update live.
- [ ] Refused with clear messages: no buyer, no books, zero quantity, same book twice, future date, payment above the total.
- [ ] **Review order** shows the summary; **Save order** opens the order page (#n); double-clicking Save creates one order only.
- [ ] Creating an order does **not** change stock (check Stock before and after).

## 2. Orders list and order page

- [ ] List shows #n, buyer, buyer type, copies, total, paid, balance, payment and giving badges.
- [ ] Search (order number, buyer, student number, phone, email) and filters (buyer type, payment status, order status, from/to dates); Clear filters.
- [ ] Order page: buyer details, books with unit price and line total, total / paid / balance, payments, books given (who, when), history.
- [ ] Record payment, Give books, Change discount and Cancel appear only when they apply.
- [ ] Change discount can't go below what was paid; not allowed on a cancelled order.

## 3. Payments

- [ ] Tabs read **Balance** (first, opens by default: orders still owing) and **History** (last: every payment).
- [ ] History: search by order number, buyer, phone or reference; filters for buyer type, method and dates.
- [ ] A payment taken in Create Order appears **once** in History and on the order.
- [ ] **Record payment** (partial) → "Partially paid"; overpaying is refused; double click records one payment.
- [ ] Finance page: book order payments are **income** (category book_order); no expense is created.

## 4. Give Books

- [ ] Give Books → a student → **Create Order** opens the same form with that student chosen.
- [ ] Giving is refused until the order is fully paid, then refused if out of stock; never more than ordered.
- [ ] After giving, stock drops by the quantity given; the order shows "All given"; the student's page lists the books given.
- [ ] No "Receive stock" action exists anywhere.
- [ ] The old pre-order history link opens `/academy/books/pre-orders` read-only.

## 5. Books Reports (`/academy/books/reports`)

- [ ] Burgundy summary band: Total sold, Received, Balance to collect, Copies (orders and Sell together).
- [ ] **Orders** card: orders, total, received, balance; "Fully paid" and "Books given" bars.
- [ ] **Sell** card: sales, total, received (with refunds), balance; "Fully paid" bar.
- [ ] Panels: order payments, books given, buyers and payment methods.
- [ ] **Books** table: ordered, given and sold per book, with the copies bar.
- [ ] From/To dates filter all figures; cancelled orders are never counted; different currencies are shown side by side.

## 6. Finance reports and CSV export (`/academy/reports`)

- [ ] No "Paid to book suppliers" tile; other tiles unchanged.
- [ ] Export CSV: no "Paid to Book Suppliers" row; figures match the page.
- [ ] Program fee collection and payments by source (program / course / other) include new payments.

## 7. Student page and program enrollment

- [ ] Overview order: **photo → Student details → program card(s) → fee totals → Enrolled courses → Past courses → Books issued**.
- [ ] A program student (e.g. STD-000011, full stack) shows as **enrolled** on the Students list, never "Not enrolled".
- [ ] Program card: courses Active, fee, installments (e.g. "3 of 12 paid"), program payments, Record payment, **Withdraw from program**.
- [ ] Enrolled courses: program courses say **"Managed by program"** with **no Withdraw**; individual courses keep **Withdraw** (for roles allowed to withdraw).
- [ ] Batch page: program courses in Enrolled students carry a **Program** tag and "Manage on student page", with no Withdraw or Delete.
- [ ] Enroll dialog (Students list, student page, Admissions, Batch page with the batch locked) behaves the same everywhere.
- [ ] Course dropdown shows **course names only** (no "(2 batches)"); batch dropdown shows the **batch name only**; program batches show "program · batch name".
- [ ] Program enrollment shows fee and installments; it appears on the student page with its program card.
- [ ] Taking a payment while enrolling creates a receipt.
- [ ] Enrolling the same student twice in the same program or course is refused.
- [ ] Withdraw from program (TEST student only): program and all its courses withdrawn together; payments and receipts kept.

## 8. Batches

- [ ] List: summary cards (Batches, Accepting students, Completed), search, status and branch filters, **Starts** column.
- [ ] More than two courses show as two chips plus **"+N more"** (hover shows all).
- [ ] Status badges: Planned blue, Active green, Completed and Archived gray. No legend or "Accepts new students" text.
- [ ] Detail page: **← All batches** back link, title with status badge, open/closed enrollment notice, Batch card.
- [ ] Course dates: **Set dates / Edit dates** link opens "Dates for <course>" with course length, both dates required, **"Course length, N weeks"** fill, and Clear dates.
- [ ] Edit batch → Status dropdown: Planned / Active / Completed with their descriptions; hint "To archive this batch, use the Archive action."
- [ ] New batches start **Planned**.
- [ ] TEST batch set to **Completed** → enrolling a student is refused ("This batch is completed…"); back to **Active** → allowed again.
- [ ] Archive the TEST batch → Edit batch shows "This batch is archived. Use Restore to bring it back."; enrolling is refused.
- [ ] **Restore** brings back the status it had before archiving (e.g. Completed), not always Active.

## 9. Permissions

| Area | Owner | Administrator | Manager | Trainer |
|---|---|---|---|---|
| Books orders, payments, Give Books, Reports | Manage | Manage | Manage | No access |
| Finance (payments, income, expenses), finance reports | Full / approve | Full / approve | Full / approve | No access |
| Staff | Full | Full | Manage | No access |
| Batches, courses, programs, branches, admissions | Manage | Manage | Manage | Blocked page |
| Students | Manage | Manage | Manage | View (their students) |
| Timetable, exams (marks), results | Yes | Yes | Yes | Yes (their batches) |
| Grant all-branch access to staff | **Owner only** | No | No | No |

- [ ] Owner: every action above works.
- [ ] Administrator: same as the Owner except owner-only actions (e.g. granting all-branch access) are not offered.
- [ ] Manager: as in the table.
- [ ] Trainer: menu is only Dashboard, Students, Timetable, Exams, Results; opening `/academy/books/orders`, `/academy/finance`, `/academy/reports`, `/academy/staff` or `/academy/batches` directly is refused or shows the blocked page.
- [ ] Buttons a role can't use are hidden, not just disabled.

## General

- [ ] No console errors on any page.
- [ ] Phone width: dialogs and tables usable without horizontal page scroll.
- [ ] Isolation: a second academy's user opening a first-academy URL (e.g. `/academy/books/orders/<id>`, `/academy/batches/<id>`) gets "not found", never the data.
