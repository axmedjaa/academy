import { randomUUID } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { academies, academyMemberships, academySubscriptions, auditLogs, books, subscriptionPlans, users } from "@/lib/db/schema";
import { getBookCoverKey } from "@/lib/storage/keys";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import {
  adjustBookStock,
  createBook,
  getBook,
  getStockStatus,
  listBookStockMovements,
  listBooks,
  removeBookCover,
  requestBookCoverUploadUrl,
  requestNewBookCoverUploadUrl,
  updateBook,
  type CreateBookInput,
} from "./books";

// A cover is optional; one that is given must verify — same mock pattern
// as lib/academies/academy-logo.test.ts (never hits real R2 in tests).
vi.mock("@/lib/storage/client", () => ({
  // Plan storage allowance (lib/subscriptions/usage.ts): an empty bucket.
  sumObjectSizesByPrefix: vi.fn(async () => ({ ok: true as const, totalBytes: 0 })),
  getUploadUrl: vi.fn(),
  deleteObject: vi.fn(),
  getDownloadUrl: vi.fn(),
  headObject: vi.fn(),
  getObjectPrefix: vi.fn(),
}));
import { deleteObject, getObjectPrefix, getUploadUrl, headObject } from "@/lib/storage/client";
import { VALID_SIGNATURE_BYTES } from "@/lib/storage/test-signature-fixtures";
import { legacyAllBranchAccess } from "@/lib/testing/legacy-all-branch-access";
const headObjectMock = vi.mocked(headObject);
const getUploadUrlMock = vi.mocked(getUploadUrl);
const deleteObjectMock = vi.mocked(deleteObject);
const getObjectPrefixMock = vi.mocked(getObjectPrefix);

beforeEach(() => {
  headObjectMock.mockReset();
  getUploadUrlMock.mockReset();
  deleteObjectMock.mockReset();
  getObjectPrefixMock.mockReset();
  headObjectMock.mockResolvedValue({ ok: true, exists: true, info: { contentType: "image/png", contentLength: 1000 } });
  getUploadUrlMock.mockResolvedValue({ ok: true, uploadUrl: "https://example.test/upload", expiresInSeconds: 300 });
  deleteObjectMock.mockResolvedValue({ ok: true });
  getObjectPrefixMock.mockResolvedValue({ ok: true, exists: true, bytes: VALID_SIGNATURE_BYTES["image/png"] });
});

/** A cover key shaped exactly like `getBookCoverKey` produces for this
 * academy — paired with the `headObjectMock` default above (a verified
 * upload), this is what every test's `createBook` call uses unless it's
 * specifically testing the cover-requirement/verification gate itself. */
function validCoverRef(academyId: string): string {
  return getBookCoverKey({ academyId, extension: "png" });
}

async function createTestBook(
  context: AuthContext,
  academyId: string,
  overrides: Partial<CreateBookInput> = {},
) {
  return createBook(context, {
    name: "Test Book",
    priceCents: 800,
    stockQuantity: 20,
    coverRef: validCoverRef(academyId),
    ...overrides,
  });
}

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db.insert(users).values({ email: `books-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" }).returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      // Never offered at registration, even if cleanup is interrupted.
      isActive: false,
      description: "Automated test fixture (lib/academies/books.test.ts)",
      name: `Books Test Plan ${randomUUID()}`,
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
  return plan.id;
}

async function createAcademy(creatorUserId: string): Promise<string> {
  const [academy] = await db
    .insert(academies)
    .values({ name: `Books Test Academy ${randomUUID()}`, slug: `books-test-${randomUUID()}`, defaultCurrency: "USD", createdBy: creatorUserId })
    .returning({ id: academies.id });
  createdAcademyIds.push(academy.id);
  return academy.id;
}

async function addMembership(userId: string, academyId: string, role: AcademyRole): Promise<void> {
  await db.insert(academyMemberships).values({ userId, academyId, role, status: "active", academyWide: legacyAllBranchAccess(role) });
}

async function setupAcademy(role: AcademyRole): Promise<{ academyId: string; context: AuthContext }> {
  const creatorUserId = await createUser();
  const academyId = await createAcademy(creatorUserId);
  const planId = await createPlan();
  await db.insert(academySubscriptions).values({ academyId, planId, status: "active", endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), createdBy: creatorUserId });
  const userId = await createUser();
  await addMembership(userId, academyId, role);
  return { academyId, context: { userId, branchIds: [], academyWide: false } };
}

afterAll(async () => {
  await db.delete(auditLogs).where(or(...createdAcademyIds.map((id) => eq(auditLogs.academyId, id)), ...createdUserIds.map((id) => eq(auditLogs.actorUserId, id))));
  for (const academyId of createdAcademyIds) {
    await db.delete(books).where(eq(books.academyId, academyId));
    await db.delete(academySubscriptions).where(eq(academySubscriptions.academyId, academyId));
    await db.delete(academyMemberships).where(eq(academyMemberships.academyId, academyId));
  }
  for (const academyId of createdAcademyIds) {
    await db.delete(academies).where(eq(academies.id, academyId));
  }
  for (const planId of createdPlanIds) {
    await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, planId));
  }
  for (const userId of createdUserIds) {
    await db.delete(users).where(eq(users.id, userId));
  }
}, 90_000);

describe("createBook", () => {
  it("Manager can create a book", async () => {
    for (const role of ["manager"] as const) {
      const { academyId, context } = await setupAcademy(role);
      const result = await createTestBook(context, academyId, { name: "English Grammar Book" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.book.status).toBe("active");
        expect(result.book.currency).toBe("USD");
        expect(result.book.coverRef).not.toBeNull();
      }
    }
  });

  it("Owner/Admin can create a book (Academy Owner rule)", async () => {
    for (const role of ["academy_owner", "academy_admin"] as const) {
      const { academyId, context } = await setupAcademy(role);
      const result = await createTestBook(context, academyId);
      expect(result.ok).toBe(true);
    }
  });

  it("Trainer has no access", async () => {
    for (const role of ["trainer"] as const) {
      const { academyId, context } = await setupAcademy(role);
      const result = await createTestBook(context, academyId);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("forbidden");
    }
  });

  it("rejects a negative price or stock at the schema layer", async () => {
    const { academyId, context } = await setupAcademy("manager");
    const result = await createTestBook(context, academyId, { priceCents: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("creates a book with no cover (the cover is optional) without touching storage", async () => {
    const { context } = await setupAcademy("manager");
    for (const input of [
      { name: "No Cover", priceCents: 500, stockQuantity: 5 },
      { name: "Empty Cover", priceCents: 500, stockQuantity: 5, coverRef: "" },
    ]) {
      const result = await createBook(context, input);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.book.coverRef).toBeNull();
    }
    expect(headObjectMock).not.toHaveBeenCalled();
  });

  it("rejects creation whose cover key belongs to a different academy", async () => {
    const { context } = await setupAcademy("manager");
    const other = await setupAcademy("manager");
    const result = await createTestBook(context, other.academyId, { name: "Mismatched cover" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
    expect(headObjectMock).not.toHaveBeenCalled();
  });

  it("rejects creation when the uploaded cover object can't be found in storage", async () => {
    const { academyId, context } = await setupAcademy("manager");
    headObjectMock.mockResolvedValueOnce({ ok: true, exists: false });
    const result = await createTestBook(context, academyId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects creation when the uploaded object is an invalid format, and deletes the orphaned object", async () => {
    const { academyId, context } = await setupAcademy("manager");
    headObjectMock.mockResolvedValueOnce({ ok: true, exists: true, info: { contentType: "application/pdf", contentLength: 1000 } });
    const result = await createTestBook(context, academyId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
    expect(deleteObjectMock).toHaveBeenCalled();
  });

  it("rejects creation when the real bytes don't match the declared content-type (spoofed MIME), and deletes the orphaned object", async () => {
    const { academyId, context } = await setupAcademy("manager");
    const { INVALID_SIGNATURE_BYTES } = await import("@/lib/storage/test-signature-fixtures");
    getObjectPrefixMock.mockResolvedValueOnce({ ok: true, exists: true, bytes: INVALID_SIGNATURE_BYTES });
    const result = await createTestBook(context, academyId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
    expect(deleteObjectMock).toHaveBeenCalled();
  });

  it("rejects creation when the uploaded object is empty (0 bytes), and deletes the orphaned object", async () => {
    const { academyId, context } = await setupAcademy("manager");
    headObjectMock.mockResolvedValueOnce({ ok: true, exists: true, info: { contentType: "image/png", contentLength: 0 } });
    const result = await createTestBook(context, academyId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
    expect(deleteObjectMock).toHaveBeenCalled();
  });
});

describe("listBooks — search by name, ISBN, or author", () => {
  it("matches on name, ISBN, or author independently", async () => {
    const { academyId, context } = await setupAcademy("manager");
    await createTestBook(context, academyId, { name: "English Grammar", isbn: "ISBN-1111", author: "Jane Smith" });
    await createTestBook(context, academyId, { name: "Mathematics Basics", isbn: "ISBN-2222", author: "John Doe" });

    const byName = await listBooks(context, { search: "grammar" });
    expect(byName.ok).toBe(true);
    if (byName.ok) expect(byName.books.map((b) => b.name)).toEqual(["English Grammar"]);

    const byIsbn = await listBooks(context, { search: "2222" });
    expect(byIsbn.ok).toBe(true);
    if (byIsbn.ok) expect(byIsbn.books.map((b) => b.name)).toEqual(["Mathematics Basics"]);

    const byAuthor = await listBooks(context, { search: "jane" });
    expect(byAuthor.ok).toBe(true);
    if (byAuthor.ok) expect(byAuthor.books.map((b) => b.name)).toEqual(["English Grammar"]);
  });
});

describe("getStockStatus", () => {
  it("buckets stock into out_of_stock / low_stock / in_stock", () => {
    expect(getStockStatus(0)).toBe("out_of_stock");
    expect(getStockStatus(5)).toBe("low_stock");
    expect(getStockStatus(6)).toBe("in_stock");
  });
});

describe("updateBook / listBooks / getBook — tenant isolation", () => {
  it("cannot update a book belonging to a different academy", async () => {
    const { context } = await setupAcademy("manager");
    const other = await setupAcademy("manager");
    const created = await createTestBook(other.context, other.academyId, { name: "Other Academy Book", priceCents: 500 });
    if (!created.ok) throw new Error("expected ok");

    const result = await updateBook(context, created.book.id, { priceCents: 999 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("getBook and listBooks only ever return this academy's own books", async () => {
    const { academyId, context } = await setupAcademy("manager");
    const other = await setupAcademy("manager");
    const mine = await createTestBook(context, academyId, { name: "My Book", priceCents: 500 });
    const theirs = await createTestBook(other.context, other.academyId, { name: "Their Book", priceCents: 500 });
    if (!mine.ok || !theirs.ok) throw new Error("expected ok");

    const listed = await listBooks(context);
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.books.map((b) => b.id)).toContain(mine.book.id);
      expect(listed.books.map((b) => b.id)).not.toContain(theirs.book.id);
    }

    const got = await getBook(context, theirs.book.id);
    expect(got.ok).toBe(false);
  });

  it("toggling status to inactive is reflected in a later read", async () => {
    const { academyId, context } = await setupAcademy("manager");
    const created = await createTestBook(context, academyId, { priceCents: 500 });
    if (!created.ok) throw new Error("expected ok");
    const updated = await updateBook(context, created.book.id, { status: "inactive" });
    expect(updated.ok).toBe(true);
    if (updated.ok) expect(updated.book.status).toBe("inactive");
  });

  it("records a bookStockChanged audit row when stock is manually edited, but not when it is unchanged", async () => {
    const { academyId, context } = await setupAcademy("manager");
    const created = await createTestBook(context, academyId, { priceCents: 500, stockQuantity: 10 });
    if (!created.ok) throw new Error("expected ok");

    await updateBook(context, created.book.id, { stockQuantity: 25 });
    // Scoped to this book's own entityId — an unscoped full-table count here
    // would race with other test files' concurrent inserts of the same
    // "bookStockChanged" action under parallel vitest workers (e.g.
    // book-sales.test.ts's own sale/refund stock-change events).
    const stockChangedRowsForBook = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "bookStockChanged"), eq(auditLogs.entityId, created.book.id)));
    expect(stockChangedRowsForBook.length).toBe(1);

    await updateBook(context, created.book.id, { name: "Renamed, stock untouched" });
    const stockChangedRowsForBookAfter = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "bookStockChanged"), eq(auditLogs.entityId, created.book.id)));
    expect(stockChangedRowsForBookAfter.length).toBe(1);
  });
});

describe("adjustBookStock — Add / Remove with a reason", () => {
  it("Add raises stock and audits direction, reason, delta and note", async () => {
    const { academyId, context } = await setupAcademy("manager");
    const created = await createTestBook(context, academyId, { stockQuantity: 3 });
    if (!created.ok) throw new Error("expected ok");

    const result = await adjustBookStock(context, created.book.id, { direction: "in", quantity: 12, reason: "received", note: "Supplier invoice 1042" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.book.stockQuantity).toBe(15);
      expect(result.delta).toBe(12);
    }

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "bookStockChanged"), eq(auditLogs.entityId, created.book.id)));
    expect(audit.before).toEqual({ stockQuantity: 3 });
    expect(audit.after).toEqual({ stockQuantity: 15 });
    expect(audit.context).toMatchObject({ source: "adjustment", direction: "in", reason: "received", delta: 12, note: "Supplier invoice 1042" });
  });

  it("Remove lowers stock, and can never take more than is in stock", async () => {
    const { academyId, context } = await setupAcademy("manager");
    const created = await createTestBook(context, academyId, { stockQuantity: 5 });
    if (!created.ok) throw new Error("expected ok");

    const removed = await adjustBookStock(context, created.book.id, { direction: "out", quantity: 2, reason: "damaged" });
    expect(removed.ok).toBe(true);
    if (removed.ok) {
      expect(removed.book.stockQuantity).toBe(3);
      expect(removed.delta).toBe(-2);
    }

    const tooMany = await adjustBookStock(context, created.book.id, { direction: "out", quantity: 4, reason: "lost" });
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) {
      expect(tooMany.error.code).toBe("validation");
      expect(tooMany.error.message).toMatch(/Only 3 copies are in stock/);
    }

    const all = await adjustBookStock(context, created.book.id, { direction: "out", quantity: 3, reason: "mistake" });
    expect(all.ok && all.book.stockQuantity).toBe(0);
  });

  it("concurrent adjustments all count (no lost update), and parallel removals never go below 0", async () => {
    const { academyId, context } = await setupAcademy("manager");
    const created = await createTestBook(context, academyId, { stockQuantity: 0 });
    if (!created.ok) throw new Error("expected ok");

    const adds = await Promise.all([
      adjustBookStock(context, created.book.id, { direction: "in", quantity: 5, reason: "received" }),
      adjustBookStock(context, created.book.id, { direction: "in", quantity: 7, reason: "received" }),
    ]);
    expect(adds.every((r) => r.ok)).toBe(true);

    const removals = await Promise.all(
      [1, 2, 3].map(() => adjustBookStock(context, created.book.id, { direction: "out", quantity: 5, reason: "stocktake" })),
    );
    expect(removals.filter((r) => r.ok).length).toBe(2);
    const got = await getBook(context, created.book.id);
    expect(got.ok && got.book.stockQuantity).toBe(2);
  });

  it("requires a reason that fits the direction, and a note for Other", async () => {
    const { academyId, context } = await setupAcademy("manager");
    const created = await createTestBook(context, academyId, { stockQuantity: 4 });
    if (!created.ok) throw new Error("expected ok");

    const cases = [
      { direction: "in" as const, quantity: 1, reason: "damaged" }, // a removal reason on an addition
      { direction: "out" as const, quantity: 1, reason: "received" }, // an addition reason on a removal
      { direction: "out" as const, quantity: 1, reason: "" },
      { direction: "out" as const, quantity: 1, reason: "other" }, // Other without a note
      { direction: "in" as const, quantity: 0, reason: "received" },
      { direction: "in" as const, quantity: -3, reason: "received" },
      { direction: "in" as const, quantity: 1.5, reason: "received" },
      { direction: "in" as const, quantity: 100_001, reason: "received" },
    ];
    for (const input of cases) {
      const result = await adjustBookStock(context, created.book.id, input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("validation");
    }
    const withNote = await adjustBookStock(context, created.book.id, { direction: "out", quantity: 1, reason: "other", note: "Given to the library" });
    expect(withNote.ok).toBe(true);
    const got = await getBook(context, created.book.id);
    expect(got.ok && got.book.stockQuantity).toBe(3);
  });

  it("is refused for a role without book management, and for another academy's book", async () => {
    const owner = await setupAcademy("manager");
    const created = await createTestBook(owner.context, owner.academyId, { stockQuantity: 2 });
    if (!created.ok) throw new Error("expected ok");

    const trainer = await setupAcademy("trainer");
    const refused = await adjustBookStock(trainer.context, created.book.id, { direction: "in", quantity: 5, reason: "received" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("forbidden");

    const other = await setupAcademy("manager");
    for (const direction of ["in", "out"] as const) {
      const notFound = await adjustBookStock(other.context, created.book.id, { direction, quantity: 1, reason: "stocktake" });
      expect(notFound.ok).toBe(false);
      if (!notFound.ok) expect(notFound.error.code).toBe("not_found");
    }
    const otherHistory = await listBookStockMovements(other.context, created.book.id);
    expect(otherHistory.ok).toBe(false);

    const got = await getBook(owner.context, created.book.id);
    expect(got.ok && got.book.stockQuantity).toBe(2);
  });
});

describe("listBookStockMovements — a book's stock history", () => {
  it("lists every movement newest first with reason, note, signed change and stock after", async () => {
    const { academyId, context } = await setupAcademy("manager");
    const created = await createTestBook(context, academyId, { stockQuantity: 10 });
    if (!created.ok) throw new Error("expected ok");

    await adjustBookStock(context, created.book.id, { direction: "in", quantity: 6, reason: "received", note: "Box 1" });
    await adjustBookStock(context, created.book.id, { direction: "out", quantity: 2, reason: "damaged" });

    const history = await listBookStockMovements(context, created.book.id);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.canManage).toBe(true);
    expect(history.book.stockQuantity).toBe(14);
    expect(history.movements.map((m) => [m.source, m.reason, m.delta, m.stockBefore, m.stockAfter])).toEqual([
      ["adjustment", "damaged", -2, 16, 14],
      ["adjustment", "received", 6, 10, 16],
    ]);
    expect(history.movements[1].note).toBe("Box 1");
    expect(history.movements[0].byLabel).toBeTruthy();
  });
});

describe("book cover upload — permission and validation gate", () => {
  it("rejects a disallowed content type before ever touching storage", async () => {
    const { academyId, context } = await setupAcademy("manager");
    const created = await createTestBook(context, academyId, { priceCents: 500 });
    if (!created.ok) throw new Error("expected ok");
    const result = await requestBookCoverUploadUrl(context, created.book.id, { contentType: "application/pdf", fileSizeBytes: 1000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("rejects an oversized file before ever touching storage", async () => {
    const { academyId, context } = await setupAcademy("manager");
    const created = await createTestBook(context, academyId, { priceCents: 500 });
    if (!created.ok) throw new Error("expected ok");
    const result = await requestBookCoverUploadUrl(context, created.book.id, { contentType: "image/png", fileSizeBytes: 50 * 1024 * 1024 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it.each(["image/jpeg", "image/png", "image/webp", "image/avif"])("accepts %s", async (contentType) => {
    const { context } = await setupAcademy("manager");
    const result = await requestNewBookCoverUploadUrl(context, { contentType, fileSizeBytes: 1000 });
    expect(result.ok).toBe(true);
  });

  it("rejects image/gif (no animation use case for a book cover)", async () => {
    const { context } = await setupAcademy("manager");
    const result = await requestNewBookCoverUploadUrl(context, { contentType: "image/gif", fileSizeBytes: 1000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("rejects image/svg+xml (no sanitization pipeline)", async () => {
    const { context } = await setupAcademy("manager");
    const result = await requestNewBookCoverUploadUrl(context, { contentType: "image/svg+xml", fileSizeBytes: 1000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("roles without book access cannot request a cover upload", async () => {
    const { academyId, context } = await setupAcademy("manager");
    const created = await createTestBook(context, academyId, { priceCents: 500 });
    if (!created.ok) throw new Error("expected ok");
    const owner = await setupAcademy("trainer");
    const result = await requestBookCoverUploadUrl(owner.context, created.book.id, { contentType: "image/png", fileSizeBytes: 1000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("requestNewBookCoverUploadUrl works for a NEW book (no bookId needed) and is permission-gated the same way", async () => {
    const { context } = await setupAcademy("manager");
    const result = await requestNewBookCoverUploadUrl(context, { contentType: "image/png", fileSizeBytes: 1000 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.key).toContain("book-covers/");

    const owner = await setupAcademy("trainer");
    const forbidden = await requestNewBookCoverUploadUrl(owner.context, { contentType: "image/png", fileSizeBytes: 1000 });
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) expect(forbidden.error.code).toBe("forbidden");
  });
});

describe("removeBookCover", () => {
  it("clears the cover, deletes the stored object and audits it", async () => {
    const { academyId, context } = await setupAcademy("manager");
    const created = await createTestBook(context, academyId);
    if (!created.ok) throw new Error("expected ok");
    const key = created.book.coverRef;
    expect(key).not.toBeNull();

    const result = await removeBookCover(context, created.book.id);
    expect(result.ok).toBe(true);
    const [row] = await db.select().from(books).where(eq(books.id, created.book.id));
    expect(row.coverRef).toBeNull();
    expect(deleteObjectMock).toHaveBeenCalledWith(key);
    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, created.book.id), eq(auditLogs.action, "removeBookCover")));
    expect(audit).toHaveLength(1);
  });

  it("is a harmless no-op for a book that has no cover", async () => {
    const { context } = await setupAcademy("manager");
    const created = await createBook(context, { name: "Bare", priceCents: 100, stockQuantity: 1 });
    if (!created.ok) throw new Error("expected ok");
    const result = await removeBookCover(context, created.book.id);
    expect(result.ok).toBe(true);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it("refuses a role without book management (Trainer) and leaves the cover in place", async () => {
    const { academyId, context } = await setupAcademy("manager");
    const created = await createTestBook(context, academyId);
    if (!created.ok) throw new Error("expected ok");
    const trainer = await setupAcademy("trainer");
    const result = await removeBookCover(trainer.context, created.book.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
    const [row] = await db.select().from(books).where(eq(books.id, created.book.id));
    expect(row.coverRef).toBe(created.book.coverRef);
  });

  it("never removes another academy's book cover (tenant isolation: not_found)", async () => {
    const owner = await setupAcademy("manager");
    const created = await createTestBook(owner.context, owner.academyId);
    if (!created.ok) throw new Error("expected ok");
    const attacker = await setupAcademy("manager");
    const result = await removeBookCover(attacker.context, created.book.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
    const [row] = await db.select().from(books).where(eq(books.id, created.book.id));
    expect(row.coverRef).toBe(created.book.coverRef);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });
});
