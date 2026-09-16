import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  platformAdminPermissions,
  platformMemberships,
  users,
} from "@/lib/db/schema";
import { resolveAuthContext } from "./auth-context";
import { hasPermission, UNGRANTABLE_CAPABILITIES } from "./permissions";

let ownerUserId: string;
let adminNoGrantsUserId: string;
let adminWithGrantUserId: string;
let plainUserId: string;

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `perm-test-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
    })
    .returning({ id: users.id });
  return user.id;
}

beforeAll(async () => {
  ownerUserId = await createUser();
  await db
    .insert(platformMemberships)
    .values({ userId: ownerUserId, role: "platform_owner" });

  adminNoGrantsUserId = await createUser();
  await db
    .insert(platformMemberships)
    .values({ userId: adminNoGrantsUserId, role: "platform_admin" });

  adminWithGrantUserId = await createUser();
  await db
    .insert(platformMemberships)
    .values({ userId: adminWithGrantUserId, role: "platform_admin" });
  await db.insert(platformAdminPermissions).values([
    { userId: adminWithGrantUserId, capability: "recordSubscriptionPayment" },
    // Directly inserting a grant row for an ungrantable capability, bypassing
    // whatever future grantPlatformPermission action would normally refuse
    // this — hasPermission must still reject it. This is exactly the
    // "ungrantable-capability bypass" PLAN.md's acceptance criteria requires
    // to be unit-tested.
    { userId: adminWithGrantUserId, capability: "approveAcademy" },
  ]);

  plainUserId = await createUser();
});

afterAll(async () => {
  const testUserIds = [
    ownerUserId,
    adminNoGrantsUserId,
    adminWithGrantUserId,
    plainUserId,
  ];
  for (const userId of testUserIds) {
    await db
      .delete(platformAdminPermissions)
      .where(eq(platformAdminPermissions.userId, userId));
    await db
      .delete(platformMemberships)
      .where(eq(platformMemberships.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  }
});

describe("resolveAuthContext", () => {
  it("resolves platformRole for a platform_owner", async () => {
    const context = await resolveAuthContext(ownerUserId);
    expect(context.platformRole).toBe("platform_owner");
    expect(context.branchIds).toEqual([]);
    expect(context.academyWide).toBe(false);
    expect(context.academyId).toBeUndefined();
  });

  it("resolves platformRole for a platform_admin", async () => {
    const context = await resolveAuthContext(adminNoGrantsUserId);
    expect(context.platformRole).toBe("platform_admin");
  });

  it("leaves platformRole undefined for a user with no platform membership", async () => {
    const context = await resolveAuthContext(plainUserId);
    expect(context.platformRole).toBeUndefined();
  });
});

describe("hasPermission", () => {
  it("denies everything when context is null (unauthenticated)", async () => {
    expect(await hasPermission(null, "recordSubscriptionPayment")).toBe(false);
    expect(await hasPermission(null, "approveAcademy")).toBe(false);
  });

  it("grants platform_owner every capability, including ungrantable ones", async () => {
    const context = await resolveAuthContext(ownerUserId);
    for (const capability of UNGRANTABLE_CAPABILITIES) {
      expect(await hasPermission(context, capability)).toBe(true);
    }
    expect(await hasPermission(context, "recordSubscriptionPayment")).toBe(
      true,
    );
    expect(await hasPermission(context, "some-future-capability")).toBe(true);
  });

  it("denies every ungrantable capability to platform_admin even when explicitly granted", async () => {
    const context = await resolveAuthContext(adminWithGrantUserId);
    for (const capability of UNGRANTABLE_CAPABILITIES) {
      expect(await hasPermission(context, capability)).toBe(false);
    }
  });

  it("grants a platform_admin only the specific non-ungrantable capability they were granted", async () => {
    const context = await resolveAuthContext(adminWithGrantUserId);
    expect(await hasPermission(context, "recordSubscriptionPayment")).toBe(
      true,
    );
    expect(await hasPermission(context, "queryAuditLogs")).toBe(false);
  });

  it("denies a platform_admin any capability with no grants at all", async () => {
    const context = await resolveAuthContext(adminNoGrantsUserId);
    expect(await hasPermission(context, "recordSubscriptionPayment")).toBe(
      false,
    );
  });

  it("denies a user with no platform role any capability", async () => {
    const context = await resolveAuthContext(plainUserId);
    expect(await hasPermission(context, "recordSubscriptionPayment")).toBe(
      false,
    );
    expect(await hasPermission(context, "approveAcademy")).toBe(false);
  });
});
