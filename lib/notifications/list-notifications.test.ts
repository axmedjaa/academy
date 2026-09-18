import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { academies, academyMemberships, notifications, users } from "@/lib/db/schema";
import type { AuthContext } from "@/lib/auth/auth-context";
import {
  listNotificationsForUser,
  markNotificationRead,
  markNotificationsRead,
} from "./list-notifications";

// ---------------------------------------------------------------------------
// Setup helpers — same per-test-file-copy convention as
// lib/notifications/notifications.test.ts / lib/academies/certificates.test.ts.
// Notification rows are inserted directly rather than via enqueueNotification
// (which also touches BullMQ and the academy_subscriptions/plan lookup) —
// this file only exercises the read/mark-as-read surface, which only cares
// about the notifications table's own columns.
// ---------------------------------------------------------------------------

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `list-notifications-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createAcademy(creatorUserId: string): Promise<string> {
  const [academy] = await db
    .insert(academies)
    .values({
      name: `List Notifications Test Academy ${randomUUID()}`,
      slug: `list-notifications-test-${randomUUID()}`,
      defaultCurrency: "USD",
      createdBy: creatorUserId,
    })
    .returning({ id: academies.id });
  createdAcademyIds.push(academy.id);
  return academy.id;
}

async function addMembership(userId: string, academyId: string): Promise<void> {
  await db.insert(academyMemberships).values({ userId, academyId, role: "academy_owner", status: "active" });
}

function contextFor(userId: string): AuthContext {
  return { userId, branchIds: [], academyWide: false };
}

interface InsertNotificationOverrides {
  academyId?: string | null;
  channel?: "email" | "sms" | "in_app";
  readAt?: Date | null;
  eventType?: string;
  templateId?: string;
}

async function insertNotification(
  userId: string | null,
  overrides: InsertNotificationOverrides = {},
): Promise<string> {
  const idempotencyKey = randomUUID();
  const [row] = await db
    .insert(notifications)
    .values({
      academyId: overrides.academyId ?? null,
      userId,
      eventType: overrides.eventType ?? "result.published",
      channel: overrides.channel ?? "in_app",
      templateId: overrides.templateId ?? "result.published",
      idempotencyKey,
      readAt: overrides.readAt ?? null,
    })
    .returning({ id: notifications.id });
  return row.id;
}

afterAll(async () => {
  for (const academyId of createdAcademyIds) {
    await db.delete(notifications).where(eq(notifications.academyId, academyId));
    await db.delete(academyMemberships).where(eq(academyMemberships.academyId, academyId));
    await db.delete(academies).where(eq(academies.id, academyId));
  }
  for (const userId of createdUserIds) {
    await db.delete(notifications).where(eq(notifications.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  }
});

describe("listNotificationsForUser", () => {
  it("is IDOR-safe: never returns another user's notifications", async () => {
    const userId = await createUser();
    const otherUserId = await createUser();
    const ownId = await insertNotification(userId);
    await insertNotification(otherUserId);

    const result = await listNotificationsForUser(contextFor(userId));

    expect(result.map((n) => n.id)).toEqual([ownId]);
  });

  it("only returns in_app channel rows, never email/sms delivery records", async () => {
    const userId = await createUser();
    const inAppId = await insertNotification(userId, { channel: "in_app" });
    await insertNotification(userId, { channel: "email" });
    await insertNotification(userId, { channel: "sms" });

    const result = await listNotificationsForUser(contextFor(userId));

    expect(result.map((n) => n.id)).toEqual([inAppId]);
  });

  it("includes platform-level (null academyId) notifications addressed to the user", async () => {
    const userId = await createUser();
    const platformId = await insertNotification(userId, { academyId: null });

    const result = await listNotificationsForUser(contextFor(userId));

    expect(result.map((n) => n.id)).toContain(platformId);
    expect(result.find((n) => n.id === platformId)?.academyId).toBeNull();
  });

  it("includes academy-scoped notifications addressed to no specific user (null userId), for an academy the caller belongs to — e.g. approval_requested rows from lib/academies/approval-requests.ts", async () => {
    const userId = await createUser();
    const academyId = await createAcademy(userId);
    await addMembership(userId, academyId);

    const sharedId = await insertNotification(null, {
      academyId,
      eventType: "expense.approval_requested",
      templateId: "finance.approval_requested",
    });

    const result = await listNotificationsForUser(contextFor(userId));

    expect(result.map((n) => n.id)).toContain(sharedId);
  });

  it("never surfaces a null-userId notification for an academy the caller does NOT belong to", async () => {
    const outsiderUserId = await createUser();
    const ownerUserId = await createUser();
    const academyId = await createAcademy(ownerUserId);
    await addMembership(ownerUserId, academyId);

    await insertNotification(null, {
      academyId,
      eventType: "expense.approval_requested",
      templateId: "finance.approval_requested",
    });

    const result = await listNotificationsForUser(contextFor(outsiderUserId));

    expect(result).toEqual([]);
  });

  it("returns newest first", async () => {
    const userId = await createUser();
    const firstId = await insertNotification(userId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const secondId = await insertNotification(userId);

    const result = await listNotificationsForUser(contextFor(userId));

    expect(result.map((n) => n.id)).toEqual([secondId, firstId]);
  });

  it("unreadOnly filters out already-read rows", async () => {
    const userId = await createUser();
    const unreadId = await insertNotification(userId, { readAt: null });
    await insertNotification(userId, { readAt: new Date() });

    const all = await listNotificationsForUser(contextFor(userId));
    const unreadOnly = await listNotificationsForUser(contextFor(userId), { unreadOnly: true });

    expect(all).toHaveLength(2);
    expect(unreadOnly.map((n) => n.id)).toEqual([unreadId]);
  });
});

describe("markNotificationRead", () => {
  it("sets read_at for a notification the caller owns", async () => {
    const userId = await createUser();
    const notificationId = await insertNotification(userId);

    const result = await markNotificationRead(contextFor(userId), notificationId);

    expect(result.ok).toBe(true);
    const [row] = await db.select().from(notifications).where(eq(notifications.id, notificationId));
    expect(row.readAt).not.toBeNull();
  });

  it("is idempotent: marking an already-read notification again preserves the original read_at", async () => {
    const userId = await createUser();
    const notificationId = await insertNotification(userId);

    await markNotificationRead(contextFor(userId), notificationId);
    const [firstRead] = await db.select().from(notifications).where(eq(notifications.id, notificationId));

    await new Promise((resolve) => setTimeout(resolve, 5));
    await markNotificationRead(contextFor(userId), notificationId);
    const [secondRead] = await db.select().from(notifications).where(eq(notifications.id, notificationId));

    expect(secondRead.readAt?.getTime()).toBe(firstRead.readAt?.getTime());
  });

  it("is IDOR-safe: refuses to mark another user's notification read, with a generic not_found", async () => {
    const userId = await createUser();
    const otherUserId = await createUser();
    const otherNotificationId = await insertNotification(otherUserId);

    const result = await markNotificationRead(contextFor(userId), otherNotificationId);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
    const [row] = await db.select().from(notifications).where(eq(notifications.id, otherNotificationId));
    expect(row.readAt).toBeNull();
  });

  it("returns a generic not_found for a well-formed but nonexistent id", async () => {
    const userId = await createUser();

    const result = await markNotificationRead(contextFor(userId), randomUUID());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("returns a generic not_found for a malformed id", async () => {
    const userId = await createUser();

    const result = await markNotificationRead(contextFor(userId), "not-a-uuid");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("markNotificationsRead (bulk)", () => {
  it("marks only the caller's own ids among a mixed set, ownership-checked per row", async () => {
    const userId = await createUser();
    const otherUserId = await createUser();
    const ownId1 = await insertNotification(userId);
    const ownId2 = await insertNotification(userId);
    const otherId = await insertNotification(otherUserId);

    const result = await markNotificationsRead(contextFor(userId), [ownId1, ownId2, otherId]);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.markedCount).toBe(2);

    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.id, otherId));
    expect(rows[0].readAt).toBeNull();
  });

  it("rejects an empty id list with a validation error", async () => {
    const userId = await createUser();

    const result = await markNotificationsRead(contextFor(userId), []);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });
});
