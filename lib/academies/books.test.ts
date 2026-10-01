import { randomUUID } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { academies, academyMemberships, academySubscriptions, auditLogs, books, subscriptionPlans, users } from "@/lib/db/schema";
import { getBookCoverKey } from "@/lib/storage/keys";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import {
  createBook,
  getBook,
  getStockStatus,
  listBooks,
  requestBookCoverUploadUrl,
  requestNewBookCoverUploadUrl,
  updateBook,
  type CreateBookInput,
} from "./books";

// Every `createBook` call now requires a verified cover — same mock pattern
// as lib/academies/academy-logo.test.ts (never hits real R2 in tests).
vi.mock("@/lib/storage/client", () => ({
  getUploadUrl: vi.fn(),
  deleteObject: vi.fn(),
  getDownloadUrl: vi.fn(),
  headObject: vi.fn(),
}));
import { deleteObject, getUploadUrl, headObject } from "@/lib/storage/client";
const headObjectMock = vi.mocked(headObject);
const getUploadUrlMock = vi.mocked(getUploadUrl);
const deleteObjectMock = vi.mocked(deleteObject);

beforeEach(() => {
  headObjectMock.mockReset();
  getUploadUrlMock.mockReset();
  deleteObjectMock.mockReset();
  headObjectMock.mockResolvedValue({ ok: true, exists: true, info: { contentType: "image/png", contentLength: 1000 } });
  getUploadUrlMock.mockResolvedValue({ ok: true, uploadUrl: "https://example.test/upload", expiresInSeconds: 300 });
  deleteObjectMock.mockResolvedValue({ ok: true });
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
  await db.insert(academyMemberships).values({ userId, academyId, role, status: "active" });
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
});

describe("createBook", () => {
  it("Manager/Finance Officer can create a book", async () => {
    for (const role of ["manager", "finance_officer"] as const) {
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

  it("Owner/Admin (view-only) cannot create a book", async () => {
    for (const role of ["academy_owner", "academy_admin"] as const) {
      const { academyId, context } = await setupAcademy(role);
      const result = await createTestBook(context, academyId);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("forbidden");
    }
  });

  it("Admissions Officer/Trainer have no access", async () => {
    for (const role of ["admissions_officer", "trainer"] as const) {
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

  it("rejects creation with no cover reference at all (required field)", async () => {
    const { context } = await setupAcademy("manager");
    // @ts-expect-error deliberately omitting the required coverRef
    const result = await createBook(context, { name: "No Cover", priceCents: 500, stockQuantity: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
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

  it("view-only roles cannot request a cover upload", async () => {
    const { academyId, context } = await setupAcademy("manager");
    const created = await createTestBook(context, academyId, { priceCents: 500 });
    if (!created.ok) throw new Error("expected ok");
    const owner = await setupAcademy("academy_owner");
    const result = await requestBookCoverUploadUrl(owner.context, created.book.id, { contentType: "image/png", fileSizeBytes: 1000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("requestNewBookCoverUploadUrl works for a NEW book (no bookId needed) and is permission-gated the same way", async () => {
    const { context } = await setupAcademy("manager");
    const result = await requestNewBookCoverUploadUrl(context, { contentType: "image/png", fileSizeBytes: 1000 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.key).toContain("book-covers/");

    const owner = await setupAcademy("academy_owner");
    const forbidden = await requestNewBookCoverUploadUrl(owner.context, { contentType: "image/png", fileSizeBytes: 1000 });
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) expect(forbidden.error.code).toBe("forbidden");
  });
});
