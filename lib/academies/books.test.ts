import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { academies, academyMemberships, academySubscriptions, auditLogs, books, subscriptionPlans, users } from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import { createBook, getBook, listBooks, requestBookCoverUploadUrl, updateBook } from "./books";

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
      const { context } = await setupAcademy(role);
      const result = await createBook(context, { name: "English Grammar Book", priceCents: 800, stockQuantity: 20 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.book.status).toBe("active");
        expect(result.book.currency).toBe("USD");
      }
    }
  });

  it("Owner/Admin (view-only) cannot create a book", async () => {
    for (const role of ["academy_owner", "academy_admin"] as const) {
      const { context } = await setupAcademy(role);
      const result = await createBook(context, { name: "Book", priceCents: 800, stockQuantity: 20 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("forbidden");
    }
  });

  it("Admissions Officer/Trainer have no access", async () => {
    for (const role of ["admissions_officer", "trainer"] as const) {
      const { context } = await setupAcademy(role);
      const result = await createBook(context, { name: "Book", priceCents: 800, stockQuantity: 20 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("forbidden");
    }
  });

  it("rejects a negative price or stock at the schema layer", async () => {
    const { context } = await setupAcademy("manager");
    const result = await createBook(context, { name: "Book", priceCents: -1, stockQuantity: 20 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });
});

describe("updateBook / listBooks / getBook — tenant isolation", () => {
  it("cannot update a book belonging to a different academy", async () => {
    const { context } = await setupAcademy("manager");
    const other = await setupAcademy("manager");
    const created = await createBook(other.context, { name: "Other Academy Book", priceCents: 500, stockQuantity: 5 });
    if (!created.ok) throw new Error("expected ok");

    const result = await updateBook(context, created.book.id, { priceCents: 999 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("getBook and listBooks only ever return this academy's own books", async () => {
    const { context } = await setupAcademy("manager");
    const other = await setupAcademy("manager");
    const mine = await createBook(context, { name: "My Book", priceCents: 500, stockQuantity: 5 });
    const theirs = await createBook(other.context, { name: "Their Book", priceCents: 500, stockQuantity: 5 });
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
    const { context } = await setupAcademy("manager");
    const created = await createBook(context, { name: "Book", priceCents: 500, stockQuantity: 5 });
    if (!created.ok) throw new Error("expected ok");
    const updated = await updateBook(context, created.book.id, { status: "inactive" });
    expect(updated.ok).toBe(true);
    if (updated.ok) expect(updated.book.status).toBe("inactive");
  });
});

describe("book cover upload — permission and validation gate", () => {
  it("rejects a disallowed content type before ever touching storage", async () => {
    const { context } = await setupAcademy("manager");
    const created = await createBook(context, { name: "Book", priceCents: 500, stockQuantity: 5 });
    if (!created.ok) throw new Error("expected ok");
    const result = await requestBookCoverUploadUrl(context, created.book.id, { contentType: "application/pdf", fileSizeBytes: 1000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("rejects an oversized file before ever touching storage", async () => {
    const { context } = await setupAcademy("manager");
    const created = await createBook(context, { name: "Book", priceCents: 500, stockQuantity: 5 });
    if (!created.ok) throw new Error("expected ok");
    const result = await requestBookCoverUploadUrl(context, created.book.id, { contentType: "image/png", fileSizeBytes: 50 * 1024 * 1024 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("view-only roles cannot request a cover upload", async () => {
    const { context } = await setupAcademy("manager");
    const created = await createBook(context, { name: "Book", priceCents: 500, stockQuantity: 5 });
    if (!created.ok) throw new Error("expected ok");
    const owner = await setupAcademy("academy_owner");
    const result = await requestBookCoverUploadUrl(owner.context, created.book.id, { contentType: "image/png", fileSizeBytes: 1000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });
});
