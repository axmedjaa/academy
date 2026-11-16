# Browser testing checklist — Book orders, payments, reports, enrollment

Run on **dev** (migrations 0048–0056 applied). Sign in as an owner/admin
unless a step says otherwise. Tick each box; note anything odd next to it.

**Status:** not yet performed. Claude-in-Chrome had no connected browser on
2026-11-15, so nothing below has been verified in a browser.

## Manual procedure

1. `npm run dev`, open `http://localhost:3000`, sign in to a **test
   academy** on dev (never a real academy's data).
2. Accounts needed in that academy: Academy Owner, Manager, Finance
   Officer, Trainer — plus one user of a **second** academy (isolation).
   If the permission work is *not* in the build being tested, run sections
   1–5 as the **Manager** (the Owner only has view on Books there).
3. Open DevTools → Console, filter “Errors”; keep it open for every page.
   Note any red entry with its page.
4. Desktop pass: window ≥ 1280 px wide, sections 1–6 below in order (they
   build on each other: section 3 pays the order made in section 1).
5. Mobile pass: DevTools device toolbar, 390 × 844 (iPhone 12-class).
   Repeat one item per section: open the main list, open one dialog, submit
   it. Check: no horizontal page scroll, dialogs fit and scroll, buttons ≥
   44 px tall, tables collapse to stacked rows.
6. Permissions pass: sign in as the Trainer, then the Finance Officer, and
   visit `/academy/books/orders`, `/academy/books/payments`,
   `/academy/finance`, `/academy/reports`. Record what each can see/do.
7. Validation: in every form, submit empty, submit a zero/negative amount,
   a future date, and double-click Save once (expect a single record).
8. Isolation: as the second academy's user, paste a first-academy URL
   (e.g. `/academy/books/orders/<id>`) → must read “not found”.
9. Record results: tick each box below, write the failing step, page,
   role, and console text next to any failure.

Key URLs: `/academy/books` (Books tab), `/academy/books/orders`,
`/academy/books/orders/<id>`, `/academy/books/payments`,
`/academy/books/distribution` (Give Books), `/academy/books/pre-orders`,
`/academy/finance`, `/academy/reports` (CSV export there),
`/academy/students`, `/academy/students/<id>`, `/academy/admissions`,
`/academy/batches/<id>`.

## 1. Create Order (one button, Student or Other buyer)
- [ ] Books tab is unchanged: **Books / Stock / Sell**, Add Book and Sell Book work as before.
- [ ] Orders tab shows **Orders / Payments / Give Books**; no supplier page, button or wording anywhere.
- [ ] The only order button is **Create Order** (hero and Orders page); Give Books has no separate "new order" button except Create Order for the chosen student.
- [ ] Create Order first asks **Who is buying these books?** — Student / Other buyer; Change goes back.
- [ ] Student: search by name, number or phone; the card shows name, student ID, branch, phone. Only this academy's (and your branches') students appear.
- [ ] Other buyer: full name required; phone and email optional; a bad email is refused; branch asked only when you have several.
- [ ] Add 2 books with quantities; line totals, subtotal, discount, total, paid now and balance update live.
- [ ] Validation: no buyer, no books, zero quantity, same book twice, future date, payment above the total are refused with clear messages.
- [ ] **Review order** shows the summary; **Save order** opens the new order's page; double-clicking saves only one order.
- [ ] Creating an order does **not** change stock (check Stock before/after).

## 2. Orders list and order details
- [ ] List shows order number (#n), buyer, buyer type, copies, total, paid, balance, payment and giving badges.
- [ ] Search by order number, buyer, student number, phone or email; filters: buyer type, payment status, order status, from/to date; Clear filters.
- [ ] Order page: buyer (type, name, student ID, branch, phone, email), books with unit price and subtotal, total/paid/balance, payments, books given (who, when), history.
- [ ] Record payment / Give books / Change discount / Cancel appear only when they apply.

## 3. Payments
- [ ] Payment taken in Create Order appears once in Payments and on the order (income, never an expense).
- [ ] **Record payment** (partial): order becomes “Partially paid”; overpaying is refused; double click records one payment.
- [ ] Tabs read **Balance** (first, opens by default: orders still owing) and **History** (last: every payment, with search by order number, buyer, phone or reference and filters for buyer type, method and dates).
- [ ] Finance: each book order payment is income (category book_order); no expense is created.

## 4. Finance reports and CSV export
- [ ] Reports page: no “Paid to book suppliers” tile; other tiles unchanged.
- [ ] Export CSV: no “Paid to Book Suppliers” row; numbers match the page.

## 5. Student book payments and Give Books
- [ ] Give Books → a student → **Create Order** opens the same form with that student chosen.
- [ ] Creating and paying a student order does **not** change stock.
- [ ] Record a partial payment → “Partially paid”; it appears as **income** (Finance / Reports), never as an expense.
- [ ] **Give Books** is refused until fully paid; then refused if out of stock; never more than ordered.
- [ ] After giving, stock drops by the quantity given and the student’s detail page lists the books given.
- [ ] Edit discount: can’t go below what was paid; not allowed on a cancelled order.
- [ ] Old pre-order history link opens `/academy/books/pre-orders` read-only.
- [ ] No “Receive stock” action exists anywhere on student orders.

## 6. Program and individual course enrollment
- [ ] Students list → Enroll: the dialog offers only the modes that apply (program / individual courses).
- [ ] Program enrollment: choose program + batch, fee and installments shown; enrollment appears on the student detail page with its program card.
- [ ] Individual course enrollment: choose courses/batches; each course shows its own fee.
- [ ] Same dialog from the student detail page, Admissions list and Batch detail (batch locked) behaves the same.
- [ ] Recording a payment during enrollment (roles allowed to take money only) creates a receipt.
- [ ] Enrolling the same student twice in the same program/course is refused.
- [ ] Withdraw a program enrollment: payments and receipts are kept.
- [ ] Reports: program fee collection and payments-by-source (program / course / other) reflect the new payments.

## General
- [ ] No console errors on each page (DevTools).
- [ ] Phone width: dialogs and tables usable without horizontal page scroll.
- [ ] A second academy’s user sees none of the first academy’s orders, payments or expenses.
