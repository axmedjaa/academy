import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  auditLogs,
  bookPreorderCampaignBooks,
  bookPreorderCampaigns,
  bookPreorderHandovers,
  bookPreorderItems,
  bookPreorderPayments,
  bookPreorderReceipts,
  bookPreorders,
  bookSalePayments,
  bookSales,
  books,
  branches,
  incomeRecords,
  staffBranchAssignments,
  staffProfiles,
  students,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import { getBookCoverKey } from "@/lib/storage/keys";
import type { AuthContext } from "@/lib/auth/auth-context";
import { createBook, getBook } from "./books";
import { createBookSale } from "./book-sales";
import {
  createPreorder,
  getPreorderOverview,
  givePreorderBooks,
  recordPreorderPayment,
  recordPreorderReceipt,
  saveCampaign,
  setCampaignStatus,
  verifyPreorderPayment,
} from "./book-preorders";
import { computePreorderPricing, formatPreorderReference, maxGivable, preorderPaymentStatus, referenceSequence } from "./book-preorder-math";

vi.mock("@/lib/storage/client", () => ({
  sumObjectSizesByPrefix: vi.fn(async () => ({ ok: true as const, totalBytes: 0 })),
  getUploadUrl: vi.fn(),
  deleteObject: vi.fn(),
  getDownloadUrl: vi.fn(),
  headObject: vi.fn(),
  getObjectPrefix: vi.fn(),
}));
import { getObjectPrefix, headObject } from "@/lib/storage/client";
import { VALID_SIGNATURE_BYTES } from "@/lib/storage/test-signature-fixtures";

function mockVerifiedCoverUploads() {
  vi.mocked(headObject).mockReset().mockResolvedValue({ ok: true, exists: true, info: { contentType: "image/png", contentLength: 1000 } });
  vi.mocked(getObjectPrefix).mockReset().mockResolvedValue({ ok: true, exists: true, bytes: VALID_SIGNATURE_BYTES["image/png"] });
}
beforeEach(mockVerifiedCoverUploads);

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];
const today = new Date().toISOString().slice(0, 10);

async function createUser(): Promise<string> {
  const [user] = await db.insert(users).values({ email: `book-preorders-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" }).returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

interface Fixture {
  academyId: string;
  branchA: string;
  branchB: string;
  studentA: string;
  studentB: string;
  /** Manager with all-branch access. */
  manager: AuthContext;
  /** Manager limited to branch A. */
  branchManager: AuthContext;
  /** Owner: view only. */
  owner: AuthContext;
  bookX: string;
  bookY: string;
}

async function setupFixture(): Promise<Fixture> {
  const creator = await createUser();
  const [academy] = await db
    .insert(academies)
    .values({ name: `Preorder Test Academy ${randomUUID()}`, slug: `preorder-test-${randomUUID()}`, defaultCurrency: "USD", createdBy: creator })
    .returning({ id: academies.id });
  createdAcademyIds.push(academy.id);
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      isActive: false,
      description: "Automated test fixture (lib/academies/book-preorders.test.ts)",
      name: `Preorder Test Plan ${randomUUID()}`,
      priceAmountCents: 1000,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 10,
      maxStudents: 100,
      maxStaff: 10,
      maxCourses: 10,
      maxStorageBytes: 1_073_741_824,
      reportsLevel: "basic",
    })
    .returning({ id: subscriptionPlans.id });
  createdPlanIds.push(plan.id);
  await db.insert(academySubscriptions).values({ academyId: academy.id, planId: plan.id, status: "active", endsAt: new Date(Date.now() + 30 * 86400000), createdBy: creator });

  const branch = async () =>
    (await db.insert(branches).values({ academyId: academy.id, name: `Branch ${randomUUID()}`, code: `BR-${randomUUID().slice(0, 8)}` }).returning({ id: branches.id }))[0].id;
  const branchA = await branch();
  const branchB = await branch();
  const student = async (branchId: string) =>
    (
      await db
        .insert(students)
        .values({ academyId: academy.id, branchId, studentNumber: `STD-${randomUUID().slice(0, 8)}`, fullName: "Test Student", createdBy: creator })
        .returning({ id: students.id })
    )[0].id;
  const studentA = await student(branchA);
  const studentB = await student(branchB);

  const managerId = await createUser();
  await db.insert(academyMemberships).values({ userId: managerId, academyId: academy.id, role: "manager", status: "active", academyWide: true });
  const branchManagerId = await createUser();
  await db.insert(academyMemberships).values({ userId: branchManagerId, academyId: academy.id, role: "manager", status: "active", academyWide: false });
  const [profile] = await db.insert(staffProfiles).values({ academyId: academy.id, userId: branchManagerId, fullName: "Branch Manager", phone: "+1-555-0100" }).returning({ id: staffProfiles.id });
  await db.insert(staffBranchAssignments).values({ academyId: academy.id, staffProfileId: profile.id, branchId: branchA });
  const ownerId = await createUser();
  await db.insert(academyMemberships).values({ userId: ownerId, academyId: academy.id, role: "academy_owner", status: "active", academyWide: true });

  const ctx = (userId: string): AuthContext => ({ userId, branchIds: [], academyWide: false });
  const manager = ctx(managerId);
  const book = async (priceCents: number, stockQuantity: number) => {
    const result = await createBook(manager, {
      name: `Book ${randomUUID()}`,
      subject: "English",
      classLevel: "Class 3",
      priceCents,
      stockQuantity,
      coverRef: getBookCoverKey({ academyId: academy.id, extension: "png" }),
    });
    if (!result.ok) throw new Error(`failed to create book: ${result.error.message}`);
    return result.book.id;
  };

  return {
    academyId: academy.id,
    branchA,
    branchB,
    studentA,
    studentB,
    manager,
    branchManager: ctx(branchManagerId),
    owner: ctx(ownerId),
    bookX: await book(650, 10),
    bookY: await book(400, 5),
  };
}

async function openCampaign(f: Fixture, limits: { x?: number | null; y?: number | null } = {}): Promise<string> {
  const result = await saveCampaign(f.manager, null, {
    name: `Term ${randomUUID().slice(0, 6)}`,
    opensOn: "2026-10-01",
    closesOn: "2026-10-31",
    expectedArrivalOn: "2026-11-15",
    status: "open",
    books: [
      { bookId: f.bookX, quantityLimit: limits.x ?? null },
      { bookId: f.bookY, quantityLimit: limits.y ?? null },
    ],
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.campaignId;
}

/** Pays an order's whole balance without verifying it. */
async function payBalance(ctx: AuthContext, orderId: string) {
  const [order] = await db.select().from(bookPreorders).where(eq(bookPreorders.id, orderId));
  const paid = await db.select().from(bookPreorderPayments).where(eq(bookPreorderPayments.orderId, orderId));
  const balance = order.totalCents - paid.reduce((sum, p) => sum + p.amountCents, 0);
  if (balance <= 0) return;
  const result = await recordPreorderPayment(ctx, { idempotencyKey: randomUUID(), orderId, amountCents: balance, method: "cash", paidOn: today });
  if (!result.ok) throw new Error(result.error.message);
}

/** Verifies every payment of an order. */
async function verifyAll(ctx: AuthContext, orderId: string) {
  const payments = await db.select().from(bookPreorderPayments).where(eq(bookPreorderPayments.orderId, orderId));
  for (const p of payments) {
    const result = await verifyPreorderPayment(ctx, p.id);
    if (!result.ok) throw new Error(result.error.message);
  }
}

/** Pays the whole balance and verifies every payment — books are given
 * only once an order is paid in full and all its payments are verified. */
async function payInFull(ctx: AuthContext, orderId: string) {
  await payBalance(ctx, orderId);
  await verifyAll(ctx, orderId);
}

let f: Fixture;
beforeAll(async () => {
  mockVerifiedCoverUploads();
  f = await setupFixture();
});

afterAll(async () => {
  await db.delete(auditLogs).where(or(...createdAcademyIds.map((id) => eq(auditLogs.academyId, id)), ...createdUserIds.map((id) => eq(auditLogs.actorUserId, id))));
  for (const academyId of createdAcademyIds) {
    await db.delete(bookPreorderHandovers).where(eq(bookPreorderHandovers.academyId, academyId));
    await db.delete(bookPreorderReceipts).where(eq(bookPreorderReceipts.academyId, academyId));
    await db.delete(bookPreorderPayments).where(eq(bookPreorderPayments.academyId, academyId));
    await db.delete(bookPreorderItems).where(eq(bookPreorderItems.academyId, academyId));
    await db.delete(bookPreorders).where(eq(bookPreorders.academyId, academyId));
    await db.delete(bookPreorderCampaignBooks).where(eq(bookPreorderCampaignBooks.academyId, academyId));
    await db.delete(bookPreorderCampaigns).where(eq(bookPreorderCampaigns.academyId, academyId));
    await db.delete(bookSalePayments).where(eq(bookSalePayments.academyId, academyId));
    await db.delete(bookSales).where(eq(bookSales.academyId, academyId));
    await db.delete(incomeRecords).where(eq(incomeRecords.academyId, academyId));
    await db.delete(books).where(eq(books.academyId, academyId));
    await db.delete(students).where(eq(students.academyId, academyId));
    const profiles = await db.select({ id: staffProfiles.id }).from(staffProfiles).where(eq(staffProfiles.academyId, academyId));
    for (const profile of profiles) await db.delete(staffBranchAssignments).where(eq(staffBranchAssignments.staffProfileId, profile.id));
    await db.delete(staffProfiles).where(eq(staffProfiles.academyId, academyId));
    await db.delete(branches).where(eq(branches.academyId, academyId));
    await db.delete(academySubscriptions).where(eq(academySubscriptions.academyId, academyId));
    await db.delete(academyMemberships).where(eq(academyMemberships.academyId, academyId));
    await db.delete(academies).where(eq(academies.id, academyId));
  }
  for (const planId of createdPlanIds) await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, planId));
  for (const userId of createdUserIds) await db.delete(users).where(eq(users.id, userId));
});

describe("book pre-order math", () => {
  it("prices lines, applies a percentage discount and never goes below zero", () => {
    const priced = computePreorderPricing(
      [
        { unitPriceCents: 650, quantity: 2 },
        { unitPriceCents: 400, quantity: 1 },
      ],
      10,
    );
    expect(priced.lineSubtotals).toEqual([1300, 400]);
    expect(priced.subtotalCents).toBe(1700);
    expect(priced.discountAmountCents).toBe(170);
    expect(priced.totalCents).toBe(1530);
    expect(computePreorderPricing([{ unitPriceCents: 100, quantity: 1 }], 100).totalCents).toBe(0);
  });

  it("derives payment status and caps what can be given", () => {
    expect(preorderPaymentStatus(1000, 0)).toBe("unpaid");
    expect(preorderPaymentStatus(1000, 400)).toBe("partially_paid");
    expect(preorderPaymentStatus(1000, 1000)).toBe("paid");
    expect(maxGivable(3, 1, 10)).toBe(2);
    expect(maxGivable(3, 1, 1)).toBe(1);
    expect(maxGivable(3, 3, 10)).toBe(0);
  });

  it("formats and parses order references", () => {
    expect(formatPreorderReference(2026, 7)).toBe("PO-2026-0007");
    expect(referenceSequence("PO-2026-0007", 2026)).toBe(7);
    expect(referenceSequence("PO-2025-0007", 2026)).toBe(0);
  });
});

describe("campaigns", () => {
  it("validates dates and requires books", async () => {
    const bad = await saveCampaign(f.manager, null, { name: "Bad", opensOn: "2026-10-10", closesOn: "2026-10-01", expectedArrivalOn: "2026-11-01", status: "draft", books: [{ bookId: f.bookX }] });
    expect(bad.ok).toBe(false);
    const none = await saveCampaign(f.manager, null, { name: "Empty", opensOn: "2026-10-01", closesOn: "2026-10-10", expectedArrivalOn: "2026-11-01", status: "draft", books: [] });
    expect(none.ok).toBe(false);
  });

  it("is read-only for the owner and for branch-limited staff", async () => {
    const input = { name: "X", opensOn: "2026-10-01", closesOn: "2026-10-10", expectedArrivalOn: "2026-11-01", status: "draft" as const, books: [{ bookId: f.bookX }] };
    expect((await saveCampaign(f.owner, null, input)).ok).toBe(false);
    const limited = await saveCampaign(f.branchManager, null, input);
    expect(limited.ok).toBe(false);
    if (!limited.ok) expect(limited.error.code).toBe("forbidden");
  });

  it("opens and closes ordering", async () => {
    const id = await openCampaign(f);
    expect((await setCampaignStatus(f.manager, id, "closed")).ok).toBe(true);
    const order = await createPreorder(f.manager, { idempotencyKey: randomUUID(), campaignId: id, studentId: f.studentA, lines: [{ bookId: f.bookX, quantity: 1 }] });
    expect(order.ok).toBe(false);
    expect((await setCampaignStatus(f.manager, id, "open")).ok).toBe(true);
  });
});

describe("student orders", () => {
  it("creates a multi-book order with price snapshots, a reference and no stock change", async () => {
    const campaignId = await openCampaign(f);
    const stockBefore = (await getBook(f.manager, f.bookX)) as { ok: true; book: { stockQuantity: number } };
    const result = await createPreorder(f.manager, {
      idempotencyKey: randomUUID(),
      campaignId,
      studentId: f.studentA,
      discountPercent: 10,
      lines: [
        { bookId: f.bookX, quantity: 2 },
        { bookId: f.bookY, quantity: 1 },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reference).toMatch(/^PO-\d{4}-\d{4}$/);

    const [order] = await db.select().from(bookPreorders).where(eq(bookPreorders.id, result.orderId));
    expect(order.subtotalCents).toBe(1700);
    expect(order.discountAmountCents).toBe(170);
    expect(order.totalCents).toBe(1530);
    const items = await db.select().from(bookPreorderItems).where(eq(bookPreorderItems.orderId, result.orderId));
    expect(items.map((i) => i.unitPriceCents).sort()).toEqual([400, 650]);

    const stockAfter = (await getBook(f.manager, f.bookX)) as { ok: true; book: { stockQuantity: number } };
    expect(stockAfter.book.stockQuantity).toBe(stockBefore.book.stockQuantity);
  });

  it("returns the first order for a repeated idempotency key", async () => {
    const campaignId = await openCampaign(f);
    const key = randomUUID();
    const input = { idempotencyKey: key, campaignId, studentId: f.studentA, lines: [{ bookId: f.bookX, quantity: 1 }] };
    const first = await createPreorder(f.manager, input);
    const second = await createPreorder(f.manager, input);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.orderId).toBe(first.orderId);
    expect(second.duplicate).toBe(true);
  });

  it("gives every order a distinct reference", async () => {
    const campaignId = await openCampaign(f);
    const results = await Promise.all(
      [0, 1, 2].map(() => createPreorder(f.manager, { idempotencyKey: randomUUID(), campaignId, studentId: f.studentA, lines: [{ bookId: f.bookY, quantity: 1 }] })),
    );
    const refs = results.map((r) => (r.ok ? r.reference : "fail"));
    expect(new Set(refs).size).toBe(3);
  });

  it("enforces the campaign quantity limit", async () => {
    const campaignId = await openCampaign(f, { x: 2 });
    const ok = await createPreorder(f.manager, { idempotencyKey: randomUUID(), campaignId, studentId: f.studentA, lines: [{ bookId: f.bookX, quantity: 2 }] });
    expect(ok.ok).toBe(true);
    const over = await createPreorder(f.manager, { idempotencyKey: randomUUID(), campaignId, studentId: f.studentA, lines: [{ bookId: f.bookX, quantity: 1 }] });
    expect(over.ok).toBe(false);
  });

  it("keeps branch-limited staff to their own branch's students and orders", async () => {
    const campaignId = await openCampaign(f);
    const other = await createPreorder(f.branchManager, { idempotencyKey: randomUUID(), campaignId, studentId: f.studentB, lines: [{ bookId: f.bookX, quantity: 1 }] });
    expect(other.ok).toBe(false);
    const own = await createPreorder(f.branchManager, { idempotencyKey: randomUUID(), campaignId, studentId: f.studentA, lines: [{ bookId: f.bookX, quantity: 1 }] });
    expect(own.ok).toBe(true);

    const orderB = await createPreorder(f.manager, { idempotencyKey: randomUUID(), campaignId, studentId: f.studentB, lines: [{ bookId: f.bookX, quantity: 1 }] });
    expect(orderB.ok).toBe(true);
    if (!orderB.ok) return;
    const view = await getPreorderOverview(f.branchManager);
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.overview.orders.some((o) => o.id === orderB.orderId)).toBe(false);
    expect(view.overview.canManageCampaigns).toBe(false);
    const pay = await recordPreorderPayment(f.branchManager, { idempotencyKey: randomUUID(), orderId: orderB.orderId, amountCents: 100, method: "cash", paidOn: today });
    expect(pay.ok).toBe(false);
  });
});

describe("payments", () => {
  it("records partial and full payments, rejects overpayment and duplicates, and posts income", async () => {
    const campaignId = await openCampaign(f);
    const order = await createPreorder(f.manager, { idempotencyKey: randomUUID(), campaignId, studentId: f.studentA, lines: [{ bookId: f.bookX, quantity: 2 }] });
    if (!order.ok) throw new Error(order.error.message);

    const key = randomUUID();
    const partial = await recordPreorderPayment(f.manager, { idempotencyKey: key, orderId: order.orderId, amountCents: 500, method: "mobile_money", reference: "EVC-1", paidOn: today });
    expect(partial.ok).toBe(true);
    if (partial.ok) expect(partial.balanceCents).toBe(800);
    const replay = await recordPreorderPayment(f.manager, { idempotencyKey: key, orderId: order.orderId, amountCents: 500, method: "mobile_money", paidOn: today });
    expect(replay.ok && replay.duplicate).toBe(true);

    const over = await recordPreorderPayment(f.manager, { idempotencyKey: randomUUID(), orderId: order.orderId, amountCents: 801, method: "cash", paidOn: today });
    expect(over.ok).toBe(false);
    const full = await recordPreorderPayment(f.manager, { idempotencyKey: randomUUID(), orderId: order.orderId, amountCents: 800, method: "bank_transfer", paidOn: today });
    expect(full.ok).toBe(true);
    if (full.ok) expect(full.balanceCents).toBe(0);

    const payments = await db.select().from(bookPreorderPayments).where(eq(bookPreorderPayments.orderId, order.orderId));
    expect(payments).toHaveLength(2);
    expect(payments.every((p) => p.incomeRecordId !== null)).toBe(true);

    const view = await getPreorderOverview(f.manager);
    if (!view.ok) throw new Error("overview failed");
    const seen = view.overview.orders.find((o) => o.id === order.orderId)!;
    expect(seen.paymentStatus).toBe("paid");
    expect(seen.unverifiedCents).toBe(1300);

    expect((await verifyPreorderPayment(f.manager, payments[0].id)).ok).toBe(true);
    expect((await verifyPreorderPayment(f.owner, payments[1].id)).ok).toBe(false);
   }, 90_000);

  it("rejects a future payment date", async () => {
    const campaignId = await openCampaign(f);
    const order = await createPreorder(f.manager, { idempotencyKey: randomUUID(), campaignId, studentId: f.studentA, lines: [{ bookId: f.bookX, quantity: 1 }] });
    if (!order.ok) throw new Error(order.error.message);
    const future = await recordPreorderPayment(f.manager, { idempotencyKey: randomUUID(), orderId: order.orderId, amountCents: 100, method: "cash", paidOn: "2099-01-01" });
    expect(future.ok).toBe(false);
  });
});

describe("receiving and giving books", () => {
  it("tracks deliveries, damage and partial distribution without over-giving", async () => {
    const campaignId = await openCampaign(f);
    const order1 = await createPreorder(f.manager, { idempotencyKey: randomUUID(), campaignId, studentId: f.studentA, lines: [{ bookId: f.bookX, quantity: 3 }] });
    const order2 = await createPreorder(f.manager, { idempotencyKey: randomUUID(), campaignId, studentId: f.studentB, lines: [{ bookId: f.bookX, quantity: 2 }] });
    if (!order1.ok || !order2.ok) throw new Error("orders failed");
    await payInFull(f.manager, order1.orderId);
    await payInFull(f.manager, order2.orderId);

    // Nothing received yet: nothing can be given.
    expect((await givePreorderBooks(f.manager, { idempotencyKey: randomUUID(), orderId: order1.orderId, bookId: f.bookX, quantity: 1 })).ok).toBe(false);

    const damagedTooMany = await recordPreorderReceipt(f.manager, { idempotencyKey: randomUUID(), campaignId, bookId: f.bookX, quantityReceived: 2, damagedQuantity: 3, receivedOn: today });
    expect(damagedTooMany.ok).toBe(false);
    expect((await recordPreorderReceipt(f.branchManager, { idempotencyKey: randomUUID(), campaignId, bookId: f.bookX, quantityReceived: 1, receivedOn: today })).ok).toBe(false);

    // First delivery: 3 copies, 1 damaged -> 2 usable.
    const rKey = randomUUID();
    const first = await recordPreorderReceipt(f.manager, { idempotencyKey: rKey, campaignId, bookId: f.bookX, quantityReceived: 3, damagedQuantity: 1, receivedOn: today, note: "Box torn" });
    expect(first.ok).toBe(true);
    const replay = await recordPreorderReceipt(f.manager, { idempotencyKey: rKey, campaignId, bookId: f.bookX, quantityReceived: 3, damagedQuantity: 1, receivedOn: today });
    expect(replay.ok && replay.duplicate).toBe(true);

    // Order 1 wants 3, only 2 usable: giving 3 fails, giving 2 works (partial).
    expect((await givePreorderBooks(f.manager, { idempotencyKey: randomUUID(), orderId: order1.orderId, bookId: f.bookX, quantity: 3 })).ok).toBe(false);
    const gave = await givePreorderBooks(f.manager, { idempotencyKey: randomUUID(), orderId: order1.orderId, bookId: f.bookX, quantity: 2 });
    expect(gave.ok).toBe(true);
    // Pool is now empty for order 2.
    expect((await givePreorderBooks(f.manager, { idempotencyKey: randomUUID(), orderId: order2.orderId, bookId: f.bookX, quantity: 1 })).ok).toBe(false);

    // Second delivery: 4 more, all usable. Concurrent handovers can't exceed the pool.
    expect((await recordPreorderReceipt(f.manager, { idempotencyKey: randomUUID(), campaignId, bookId: f.bookX, quantityReceived: 2, receivedOn: today })).ok).toBe(true);
    const race = await Promise.all([
      givePreorderBooks(f.manager, { idempotencyKey: randomUUID(), orderId: order1.orderId, bookId: f.bookX, quantity: 1 }),
      givePreorderBooks(f.manager, { idempotencyKey: randomUUID(), orderId: order2.orderId, bookId: f.bookX, quantity: 2 }),
    ]);
    const handed = await db.select().from(bookPreorderHandovers).where(eq(bookPreorderHandovers.campaignId, campaignId));
    const totalGiven = handed.reduce((sum, h) => sum + h.quantity, 0);
    expect(totalGiven).toBeLessThanOrEqual(4); // 5 received - 1 damaged
    expect(race.some((r) => r.ok)).toBe(true);

    const view = await getPreorderOverview(f.manager);
    if (!view.ok) throw new Error("overview failed");
    const campaign = view.overview.campaigns.find((c) => c.id === campaignId)!;
    const x = campaign.books.find((b) => b.bookId === f.bookX)!;
    expect(x.ordered).toBe(5);
    expect(x.received).toBe(5);
    expect(x.damaged).toBe(1);
    expect(x.usable).toBe(4);
    expect(x.given).toBe(totalGiven);
    expect(x.available).toBe(4 - totalGiven);
   }, 90_000);

  it("never changes ordinary sale stock, and sales still deduct stock", async () => {
    const before = (await getBook(f.manager, f.bookY)) as { ok: true; book: { stockQuantity: number } };
    const campaignId = await openCampaign(f);
    const order = await createPreorder(f.manager, { idempotencyKey: randomUUID(), campaignId, studentId: f.studentA, lines: [{ bookId: f.bookY, quantity: 1 }] });
    if (!order.ok) throw new Error(order.error.message);
    await payInFull(f.manager, order.orderId);
    await recordPreorderReceipt(f.manager, { idempotencyKey: randomUUID(), campaignId, bookId: f.bookY, quantityReceived: 1, receivedOn: today });
    expect((await givePreorderBooks(f.manager, { idempotencyKey: randomUUID(), orderId: order.orderId, bookId: f.bookY, quantity: 1 })).ok).toBe(true);
    const mid = (await getBook(f.manager, f.bookY)) as { ok: true; book: { stockQuantity: number } };
    expect(mid.book.stockQuantity).toBe(before.book.stockQuantity);

    const sale = await createBookSale(f.manager, { bookId: f.bookY, buyerType: "student", studentId: f.studentA, quantity: 1 });
    expect(sale.ok).toBe(true);
    const after = (await getBook(f.manager, f.bookY)) as { ok: true; book: { stockQuantity: number } };
    expect(after.book.stockQuantity).toBe(before.book.stockQuantity - 1);
  }, 90_000);

  it("gives books only once the order is paid in full and every payment is verified, for students and other people", async () => {
    const campaignId = await openCampaign(f);
    const student = await createPreorder(f.manager, { idempotencyKey: randomUUID(), campaignId, studentId: f.studentA, lines: [{ bookId: f.bookY, quantity: 1 }] });
    const other = await createPreorder(f.manager, {
      idempotencyKey: randomUUID(),
      campaignId,
      buyerType: "other_person",
      buyerName: "Hodan Ali",
      buyerPhone: "+252 63 411 0021",
      branchId: f.branchB,
      lines: [{ bookId: f.bookY, quantity: 1 }],
    });
    if (!student.ok || !other.ok) throw new Error("orders failed");
    await recordPreorderReceipt(f.manager, { idempotencyKey: randomUUID(), campaignId, bookId: f.bookY, quantityReceived: 5, receivedOn: today });

    for (const orderId of [student.orderId, other.orderId]) {
      // Unpaid: blocked, with the outstanding balance in the message.
      const unpaid = await givePreorderBooks(f.manager, { idempotencyKey: randomUUID(), orderId, bookId: f.bookY, quantity: 1 });
      expect(unpaid.ok).toBe(false);
      if (!unpaid.ok) expect(unpaid.error.message).toMatch(/not fully paid.*4\.00/i);
      // Partly paid: still blocked.
      expect((await recordPreorderPayment(f.manager, { idempotencyKey: randomUUID(), orderId, amountCents: 100, method: "cash", paidOn: today })).ok).toBe(true);
      const partial = await givePreorderBooks(f.manager, { idempotencyKey: randomUUID(), orderId, bookId: f.bookY, quantity: 1 });
      expect(partial.ok).toBe(false);
      if (!partial.ok) expect(partial.error.message).toMatch(/3\.00/);
      // Paid in full but not verified: still blocked, naming the amount to verify.
      await payBalance(f.manager, orderId);
      const unverified = await givePreorderBooks(f.manager, { idempotencyKey: randomUUID(), orderId, bookId: f.bookY, quantity: 1 });
      expect(unverified.ok).toBe(false);
      if (!unverified.ok) expect(unverified.error.message).toMatch(/paid in full.*4\.00.*not verified/i);
      // Verify one payment only: still blocked.
      const [firstPayment] = await db.select().from(bookPreorderPayments).where(eq(bookPreorderPayments.orderId, orderId)).limit(1);
      expect((await verifyPreorderPayment(f.manager, firstPayment.id)).ok).toBe(true);
      expect((await givePreorderBooks(f.manager, { idempotencyKey: randomUUID(), orderId, bookId: f.bookY, quantity: 1 })).ok).toBe(false);
      // Every payment verified: allowed.
      await verifyAll(f.manager, orderId);
      expect((await givePreorderBooks(f.manager, { idempotencyKey: randomUUID(), orderId, bookId: f.bookY, quantity: 1 })).ok).toBe(true);
    }
    const handed = await db.select().from(bookPreorderHandovers).where(eq(bookPreorderHandovers.campaignId, campaignId));
    expect(handed.reduce((sum, h) => sum + h.quantity, 0)).toBe(2);
  }, 180_000);
});

describe("other-person orders", () => {
  it("records the buyer's name, phone and chosen branch, with several books", async () => {
    const campaignId = await openCampaign(f);
    const result = await createPreorder(f.manager, {
      idempotencyKey: randomUUID(),
      campaignId,
      buyerType: "other_person",
      buyerName: "  Jibril Warsame ",
      branchId: f.branchA,
      discountPercent: 0,
      lines: [
        { bookId: f.bookX, quantity: 1 },
        { bookId: f.bookY, quantity: 2 },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [order] = await db.select().from(bookPreorders).where(eq(bookPreorders.id, result.orderId));
    expect(order.buyerType).toBe("other_person");
    expect(order.studentId).toBeNull();
    expect(order.buyerName).toBe("Jibril Warsame");
    expect(order.buyerPhone).toBeNull();
    expect(order.branchId).toBe(f.branchA);
    expect(order.totalCents).toBe(650 + 800);

    const view = await getPreorderOverview(f.manager);
    if (!view.ok) throw new Error("overview failed");
    const seen = view.overview.orders.find((o) => o.id === result.orderId)!;
    expect(seen.buyerName).toBe("Jibril Warsame");
    expect(seen.studentNumber).toBeNull();
    expect(seen.items).toHaveLength(2);
  }, 60_000);

  it("requires a name and a branch inside the caller's scope", async () => {
    const campaignId = await openCampaign(f);
    const base = { campaignId, buyerType: "other_person" as const, lines: [{ bookId: f.bookX, quantity: 1 }] };
    expect((await createPreorder(f.manager, { ...base, idempotencyKey: randomUUID(), branchId: f.branchA })).ok).toBe(false);
    expect((await createPreorder(f.manager, { ...base, idempotencyKey: randomUUID(), buyerName: "Nobody Branch" })).ok).toBe(false);
    // Branch-limited staff (branch A) can't record an order for branch B.
    const outside = await createPreorder(f.branchManager, { ...base, idempotencyKey: randomUUID(), buyerName: "Parent", branchId: f.branchB });
    expect(outside.ok).toBe(false);
    const inside = await createPreorder(f.branchManager, { ...base, idempotencyKey: randomUUID(), buyerName: "Parent", branchId: f.branchA });
    expect(inside.ok).toBe(true);
  }, 60_000);
});
