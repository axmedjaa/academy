import { randomUUID } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  auditLogs,
  platformAdminPermissions,
  platformMemberships,
  users,
} from "@/lib/db/schema";
import { resolveAuthContext } from "@/lib/auth/auth-context";
import { UNGRANTABLE_CAPABILITIES } from "@/lib/auth/permissions";
import {
  createPlatformAdminAccount,
  grantPlatformPermission,
  listPlatformStaff,
  revokePlatformPermission,
} from "./staff";

let ownerUserId: string;
let adminUserId: string;
let plainUserId: string;
const createdUserIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `staff-test-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
    })
    .returning({ id: users.id });
  return user.id;
}

async function cleanupUser(userId: string): Promise<void> {
  // createPlatformAdminAccount/grantPlatformPermission/revokePlatformPermission
  // all call recordAudit() with this userId as actorUserId (the actor) or
  // entityId (the target) — audit_logs.actor_user_id carries a real FK to
  // users.id, so those rows must go before the user row can be deleted.
  await db
    .delete(auditLogs)
    .where(or(eq(auditLogs.actorUserId, userId), eq(auditLogs.entityId, userId)));
  await db
    .delete(platformAdminPermissions)
    .where(eq(platformAdminPermissions.userId, userId));
  await db.delete(platformMemberships).where(eq(platformMemberships.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

beforeAll(async () => {
  ownerUserId = await createUser();
  await db.insert(platformMemberships).values({ userId: ownerUserId, role: "platform_owner" });

  adminUserId = await createUser();
  await db.insert(platformMemberships).values({ userId: adminUserId, role: "platform_admin" });

  plainUserId = await createUser();
});

afterAll(async () => {
  for (const userId of createdUserIds) {
    await cleanupUser(userId);
  }
  await cleanupUser(ownerUserId);
  await cleanupUser(adminUserId);
  await cleanupUser(plainUserId);
});

beforeEach(async () => {
  // Reset the admin's grants between tests so each test starts from a
  // known (empty) permission state.
  await db
    .delete(platformAdminPermissions)
    .where(eq(platformAdminPermissions.userId, adminUserId));
});

describe("createPlatformAdminAccount", () => {
  it("refuses when the actor is not platform_owner", async () => {
    const adminContext = await resolveAuthContext(adminUserId);
    const result = await createPlatformAdminAccount(adminContext, {
      email: `refused-${randomUUID()}@example.com`,
      password: "a-valid-password-123",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("forbidden");
    }
  });

  it("refuses for an unauthenticated-shaped context (no platform role)", async () => {
    const plainContext = await resolveAuthContext(plainUserId);
    const result = await createPlatformAdminAccount(plainContext, {
      email: `refused-${randomUUID()}@example.com`,
      password: "a-valid-password-123",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a password shorter than 8 characters", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await createPlatformAdminAccount(ownerContext, {
      email: `short-pw-${randomUUID()}@example.com`,
      password: "short1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
    }
  });

  it("creates a platform_admin account when the actor is platform_owner", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const email = `new-admin-${randomUUID()}@example.com`;
    const result = await createPlatformAdminAccount(ownerContext, {
      email,
      password: "a-valid-password-123",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      createdUserIds.push(result.userId);

      const [membership] = await db
        .select({ role: platformMemberships.role })
        .from(platformMemberships)
        .where(eq(platformMemberships.userId, result.userId));
      expect(membership?.role).toBe("platform_admin");
    }
  });

  it("refuses to create a second account with an already-used email", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const email = `dup-${randomUUID()}@example.com`;
    const first = await createPlatformAdminAccount(ownerContext, {
      email,
      password: "a-valid-password-123",
    });
    expect(first.ok).toBe(true);
    if (first.ok) createdUserIds.push(first.userId);

    const second = await createPlatformAdminAccount(ownerContext, {
      email,
      password: "another-valid-password",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("email_taken");
    }
  });
});

describe("grantPlatformPermission — ungrantable-capability denial", () => {
  it("refuses to grant an ungrantable capability and inserts no row", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);

    for (const capability of ["approveAcademy", "platform.staff.manage"]) {
      const result = await grantPlatformPermission(ownerContext, adminUserId, capability);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("ungrantable");
      }

      const [row] = await db
        .select({ id: platformAdminPermissions.id })
        .from(platformAdminPermissions)
        .where(
          and(
            eq(platformAdminPermissions.userId, adminUserId),
            eq(platformAdminPermissions.capability, capability),
          ),
        );
      expect(row).toBeUndefined();
    }
  });

  it("refuses every capability in UNGRANTABLE_CAPABILITIES, not just a sample", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);

    for (const capability of UNGRANTABLE_CAPABILITIES) {
      const result = await grantPlatformPermission(ownerContext, adminUserId, capability);
      expect(result.ok).toBe(false);
    }

    const rows = await db
      .select({ id: platformAdminPermissions.id })
      .from(platformAdminPermissions)
      .where(eq(platformAdminPermissions.userId, adminUserId));
    expect(rows).toHaveLength(0);
  });

  it("refuses a capability that is neither grantable nor explicitly ungrantable", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await grantPlatformPermission(
      ownerContext,
      adminUserId,
      "some-made-up-capability",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ungrantable");
    }
  });
});

describe("grantPlatformPermission — authorization", () => {
  it("refuses when the actor is a platform_admin (not platform_owner)", async () => {
    const adminContext = await resolveAuthContext(adminUserId);
    const result = await grantPlatformPermission(
      adminContext,
      adminUserId,
      "queryAuditLogs",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("forbidden");
    }
  });

  it("refuses to grant to a target that is not a platform_admin", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await grantPlatformPermission(
      ownerContext,
      plainUserId,
      "queryAuditLogs",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("target_not_platform_admin");
    }
  });

  it("grants a Phase-1 grantable capability to a platform_admin", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await grantPlatformPermission(
      ownerContext,
      adminUserId,
      "queryAuditLogs",
    );
    expect(result.ok).toBe(true);

    const [row] = await db
      .select({ id: platformAdminPermissions.id })
      .from(platformAdminPermissions)
      .where(
        and(
          eq(platformAdminPermissions.userId, adminUserId),
          eq(platformAdminPermissions.capability, "queryAuditLogs"),
        ),
      );
    expect(row).toBeDefined();
  });
});

describe("grantPlatformPermission — id validation", () => {
  it("returns a validation error for a malformed target id instead of throwing", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await grantPlatformPermission(
      ownerContext,
      "not-a-uuid",
      "queryAuditLogs",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
    }
  });
});

describe("grantPlatformPermission — audit no-op behavior", () => {
  it("writes an audit row for a fresh grant", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);

    const beforeCount = (
      await db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, adminUserId),
            eq(auditLogs.action, "grantPlatformPermission"),
          ),
        )
    ).length;

    const result = await grantPlatformPermission(
      ownerContext,
      adminUserId,
      "queryAuditLogs",
    );
    expect(result.ok).toBe(true);

    const afterCount = (
      await db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, adminUserId),
            eq(auditLogs.action, "grantPlatformPermission"),
          ),
        )
    ).length;
    expect(afterCount).toBe(beforeCount + 1);
  });

  it("does not write a second audit row when granting an already-granted capability", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const first = await grantPlatformPermission(
      ownerContext,
      adminUserId,
      "queryAuditLogs",
    );
    expect(first.ok).toBe(true);

    const beforeCount = (
      await db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, adminUserId),
            eq(auditLogs.action, "grantPlatformPermission"),
          ),
        )
    ).length;

    const second = await grantPlatformPermission(
      ownerContext,
      adminUserId,
      "queryAuditLogs",
    );
    expect(second.ok).toBe(true);

    const afterCount = (
      await db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, adminUserId),
            eq(auditLogs.action, "grantPlatformPermission"),
          ),
        )
    ).length;

    expect(afterCount).toBe(beforeCount);
  });
});

describe("revokePlatformPermission", () => {
  it("removes a previously granted capability", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    await grantPlatformPermission(ownerContext, adminUserId, "recordSubscriptionPayment");

    const result = await revokePlatformPermission(
      ownerContext,
      adminUserId,
      "recordSubscriptionPayment",
    );
    expect(result.ok).toBe(true);

    const [row] = await db
      .select({ id: platformAdminPermissions.id })
      .from(platformAdminPermissions)
      .where(
        and(
          eq(platformAdminPermissions.userId, adminUserId),
          eq(platformAdminPermissions.capability, "recordSubscriptionPayment"),
        ),
      );
    expect(row).toBeUndefined();
  });

  it("refuses when the actor is a platform_admin (not platform_owner)", async () => {
    const adminContext = await resolveAuthContext(adminUserId);
    const result = await revokePlatformPermission(
      adminContext,
      adminUserId,
      "queryAuditLogs",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("forbidden");
    }
  });

  it("returns a validation error for a malformed target id instead of throwing", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await revokePlatformPermission(
      ownerContext,
      "not-a-uuid",
      "queryAuditLogs",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
    }
  });

  it("writes an audit row when a real grant is revoked", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    await grantPlatformPermission(ownerContext, adminUserId, "queryAuditLogs");

    const beforeCount = (
      await db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, adminUserId),
            eq(auditLogs.action, "revokePlatformPermission"),
          ),
        )
    ).length;

    const result = await revokePlatformPermission(
      ownerContext,
      adminUserId,
      "queryAuditLogs",
    );
    expect(result.ok).toBe(true);

    const afterCount = (
      await db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, adminUserId),
            eq(auditLogs.action, "revokePlatformPermission"),
          ),
        )
    ).length;
    expect(afterCount).toBe(beforeCount + 1);
  });

  it("does not write an audit row when revoking a capability that was never granted", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);

    const beforeCount = (
      await db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, adminUserId),
            eq(auditLogs.action, "revokePlatformPermission"),
          ),
        )
    ).length;

    const result = await revokePlatformPermission(
      ownerContext,
      adminUserId,
      "queryAuditLogs",
    );
    expect(result.ok).toBe(true);

    const afterCount = (
      await db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, adminUserId),
            eq(auditLogs.action, "revokePlatformPermission"),
          ),
        )
    ).length;

    expect(afterCount).toBe(beforeCount);
  });
});

describe("listPlatformStaff", () => {
  it("includes owner and admin accounts with their granted capabilities", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    await grantPlatformPermission(ownerContext, adminUserId, "getPlatformReports");

    const staff = await listPlatformStaff();
    const owner = staff.find((s) => s.userId === ownerUserId);
    const admin = staff.find((s) => s.userId === adminUserId);

    expect(owner?.role).toBe("platform_owner");
    expect(admin?.role).toBe("platform_admin");
    expect(admin?.grantedCapabilities).toContain("getPlatformReports");
  });
});
