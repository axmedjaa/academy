import { randomUUID } from "node:crypto";
import { eq, inArray, like, or } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { rateLimitRedisKey } from "@/lib/rate-limit";
import {
  auditLogs,
  contactSubmissions,
  platformAdminPermissions,
  platformMemberships,
  platformWebsiteSettings,
  users,
} from "@/lib/db/schema";
import { resolveAuthContext, type AuthContext } from "@/lib/auth/auth-context";
import { getVisiblePlatformNavItems } from "@/lib/platform/nav-items";
import {
  getPublicContactSettings,
  getWebsiteSettings,
  hasPublicContact,
  updateWebsiteSettings,
  type WebsiteSettingsInput,
} from "./website-settings";
import { listContactSubmissions, setContactSubmissionStatus, submitContactMessage } from "./contact-submissions";

// Never send real email from tests: the client is replaced, and each test
// decides whether the "provider" accepts the message.
const sendEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email/client", () => ({ sendEmail }));

/**
 * Public website contact settings and contact form (migration 0038):
 * platform-owner-only settings with audit, the public read, validation, and
 * the stored contact form with rate limiting, honeypot and duplicate guard.
 */

const MARK = `website-test-${randomUUID().slice(0, 8)}`;
const userIds: string[] = [];
let owner: AuthContext;
let admin: AuthContext;
let plain: AuthContext;
let originalSettings: typeof platformWebsiteSettings.$inferSelect | undefined;
const usedIps: string[] = [];

async function user(): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ email: `${MARK}-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  userIds.push(row.id);
  return row.id;
}

function ip(): string {
  const value = `198.51.100.${Math.floor(Math.random() * 250) + 1}-${randomUUID().slice(0, 6)}`;
  usedIps.push(value);
  return value;
}

const EMPTY: WebsiteSettingsInput = {
  supportEmail: "",
  phone: "",
  whatsappNumber: "",
  officeAddress: "",
  businessHours: "",
  facebookUrl: "",
  linkedinUrl: "",
  instagramUrl: "",
  xUrl: "",
  youtubeUrl: "",
  tiktokUrl: "",
  contactFormEnabled: false,
};

function message(overrides: Record<string, string> = {}) {
  return {
    fullName: "Amina Test",
    email: `${MARK}-${randomUUID().slice(0, 6)}@example.com`,
    phone: "+252 61 555 0101",
    subject: `Question ${randomUUID().slice(0, 6)}`,
    message: "Hello, I would like to know more about Dardar for our academy.",
    ...overrides,
  };
}

beforeAll(async () => {
  [originalSettings] = await db.select().from(platformWebsiteSettings).where(eq(platformWebsiteSettings.id, true));

  const ownerId = await user();
  await db.insert(platformMemberships).values({ userId: ownerId, role: "platform_owner" });
  const adminId = await user();
  await db.insert(platformMemberships).values({ userId: adminId, role: "platform_admin" });
  // Even an explicit grant row can't unlock an ungrantable capability.
  await db.insert(platformAdminPermissions).values({ userId: adminId, capability: "platform.website.manage" });
  const plainId = await user();

  owner = await resolveAuthContext(ownerId);
  admin = await resolveAuthContext(adminId);
  plain = await resolveAuthContext(plainId);
}, 120_000);

beforeEach(() => {
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ ok: false, error: "Email delivery is not configured." });
});

afterAll(async () => {
  await db.delete(contactSubmissions).where(like(contactSubmissions.email, `${MARK}%`));
  await db.delete(platformWebsiteSettings).where(eq(platformWebsiteSettings.id, true));
  if (originalSettings) await db.insert(platformWebsiteSettings).values(originalSettings);
  await db.delete(auditLogs).where(inArray(auditLogs.actorUserId, userIds));
  await db.delete(platformAdminPermissions).where(inArray(platformAdminPermissions.userId, userIds));
  await db.delete(platformMemberships).where(inArray(platformMemberships.userId, userIds));
  await db.delete(users).where(inArray(users.id, userIds));
  for (const value of usedIps) await redis.del(rateLimitRedisKey(`contact-form:ip:${value}`));
}, 120_000);

describe("website contact settings", () => {
  it("the platform owner saves settings; it is audited with who changed it", { timeout: 60_000 }, async () => {
    const result = await updateWebsiteSettings(owner, {
      ...EMPTY,
      supportEmail: "  Support@Example.com ",
      phone: "+252 61 000 0000",
      whatsappNumber: "+252 61 111 1111",
      officeAddress: "Hargeisa\nMain Road",
      facebookUrl: "https://www.facebook.com/dardar",
      contactFormEnabled: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settings.values.supportEmail).toBe("Support@Example.com");
    expect(result.settings.values.linkedinUrl).toBeNull();

    const [row] = await db.select().from(platformWebsiteSettings).where(eq(platformWebsiteSettings.id, true));
    expect(row.updatedBy).toBe(owner.userId);

    const [audit] = await db
      .select({ action: auditLogs.action, after: auditLogs.after, actorRole: auditLogs.actorRole })
      .from(auditLogs)
      .where(eq(auditLogs.actorUserId, owner.userId));
    expect(audit.action).toBe("updateWebsiteSettings");
    expect(audit.actorRole).toBe("platform_owner");
    expect(audit.after).toMatchObject({ phone: "+252 61 000 0000", contactFormEnabled: true });

    const read = await getWebsiteSettings(owner);
    expect(read.ok && read.settings.updatedByEmail).toMatch(new RegExp(`^${MARK}`));
  });

  it("other platform roles and other users can't read or change settings", { timeout: 60_000 }, async () => {
    for (const actor of [admin, plain]) {
      const update = await updateWebsiteSettings(actor, { ...EMPTY, supportEmail: "attacker@example.com" });
      expect(!update.ok && update.error.code).toBe("forbidden");
      const read = await getWebsiteSettings(actor);
      expect(!read.ok && read.error.code).toBe("forbidden");
    }
    const [row] = await db.select().from(platformWebsiteSettings).where(eq(platformWebsiteSettings.id, true));
    expect(row.supportEmail).not.toBe("attacker@example.com");
  });

  it("the public read shows only configured fields and nothing private", { timeout: 60_000 }, async () => {
    const contact = await getPublicContactSettings();
    expect(contact.supportEmail).toBe("Support@Example.com");
    expect(contact.whatsappUrl).toBe("https://wa.me/252611111111");
    expect(contact.socials.map((s) => s.label)).toEqual(["Facebook"]);
    expect(contact.businessHours).toBeNull();
    expect(Object.keys(contact)).not.toContain("updatedBy");
    expect(hasPublicContact(contact)).toBe(true);

    await updateWebsiteSettings(owner, { ...EMPTY });
    const empty = await getPublicContactSettings();
    expect(empty.socials).toEqual([]);
    expect(hasPublicContact(empty)).toBe(false);
  });

  it("rejects invalid emails, URLs and phone numbers", { timeout: 60_000 }, async () => {
    const cases: [Partial<WebsiteSettingsInput>, string][] = [
      [{ supportEmail: "not-an-email" }, "supportEmail"],
      [{ facebookUrl: "http://facebook.com/dardar" }, "facebookUrl"],
      [{ instagramUrl: "https://evil.example.com/instagram.com" }, "instagramUrl"],
      [{ linkedinUrl: "javascript:alert(1)" }, "linkedinUrl"],
      [{ phone: "call me" }, "phone"],
      [{ whatsappNumber: "123" }, "whatsappNumber"],
    ];
    for (const [patch, field] of cases) {
      const result = await updateWebsiteSettings(owner, { ...EMPTY, ...patch });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("validation");
        expect(result.error.field).toBe(field);
      }
    }
  });

  it("there is only ever one settings record", async () => {
    await expect(db.insert(platformWebsiteSettings).values({ id: true })).rejects.toThrow();
    await expect(db.insert(platformWebsiteSettings).values({ id: false })).rejects.toThrow();
  });

  it("only the owner sees the Website settings navigation", { timeout: 60_000 }, async () => {
    const ownerKeys = (await getVisiblePlatformNavItems(owner)).map((item) => item.key);
    expect(ownerKeys).toEqual(expect.arrayContaining(["website-contact", "website-messages"]));
    const adminKeys = (await getVisiblePlatformNavItems(admin)).map((item) => item.key);
    expect(adminKeys).not.toContain("website-contact");
  });
});

describe("public contact form", () => {
  beforeAll(async () => {
    await updateWebsiteSettings(owner, { ...EMPTY, supportEmail: "support@example.com", contactFormEnabled: true });
  }, 60_000);

  it("accepts and stores a valid message as new", { timeout: 60_000 }, async () => {
    const input = message();
    expect(await submitContactMessage(input, { ip: ip() })).toEqual({ ok: true });
    const [row] = await db.select().from(contactSubmissions).where(eq(contactSubmissions.email, input.email));
    expect(row).toMatchObject({ fullName: "Amina Test", phone: "+252 61 555 0101", subject: input.subject, status: "new" });
    expect(row.createdAt).toBeInstanceOf(Date);
    // The provider declined (not configured), so no notification is recorded.
    expect(row.notifiedAt).toBeNull();
  });

  it("records a notification only when the email provider confirmed it", { timeout: 60_000 }, async () => {
    sendEmail.mockResolvedValueOnce({ ok: true });
    const input = message();
    expect((await submitContactMessage(input, { ip: ip() })).ok).toBe(true);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "support@example.com", text: expect.stringContaining("+252 61 555 0101") }),
    );
    const [row] = await db.select().from(contactSubmissions).where(eq(contactSubmissions.email, input.email));
    expect(row.notifiedAt).toBeInstanceOf(Date);
  });

  it("rejects invalid messages and stores nothing", { timeout: 60_000 }, async () => {
    const bad = [
      message({ email: "nope" }),
      message({ message: "short" }),
      message({ fullName: "   " }),
      message({ subject: "" }),
      message({ phone: "" }),
      message({ phone: "call me" }),
      message({ phone: "12345" }),
    ];
    for (const input of bad) {
      const result = await submitContactMessage(input, { ip: ip() });
      expect(!result.ok && result.error.code).toBe("validation");
    }
    const stored = await db
      .select({ id: contactSubmissions.id })
      .from(contactSubmissions)
      .where(or(...bad.map((input) => eq(contactSubmissions.subject, input.subject))));
    expect(stored).toEqual([]);
  });

  it("strips control characters from stored text", { timeout: 60_000 }, async () => {
    const input = message({ fullName: "Omar\u0000 Test\u0007" });
    expect((await submitContactMessage(input, { ip: ip() })).ok).toBe(true);
    const [row] = await db.select().from(contactSubmissions).where(eq(contactSubmissions.email, input.email));
    expect(row.fullName).toBe("Omar Test");
  });

  it("a honeypot submission looks successful but is not stored", { timeout: 60_000 }, async () => {
    const input = message({ website: "http://spam.example.com" });
    expect((await submitContactMessage(input, { ip: ip() })).ok).toBe(true);
    const rows = await db.select().from(contactSubmissions).where(eq(contactSubmissions.email, input.email));
    expect(rows).toEqual([]);
  });

  it("a duplicate submission is stored once", { timeout: 60_000 }, async () => {
    const input = message();
    const address = ip();
    expect((await submitContactMessage(input, { ip: address })).ok).toBe(true);
    expect((await submitContactMessage(input, { ip: address })).ok).toBe(true);
    const rows = await db.select().from(contactSubmissions).where(eq(contactSubmissions.email, input.email));
    expect(rows).toHaveLength(1);
  });

  it("rate-limits repeated messages from one connection", { timeout: 90_000 }, async () => {
    const address = ip();
    for (let i = 0; i < 5; i++) {
      expect((await submitContactMessage(message(), { ip: address })).ok).toBe(true);
    }
    const blocked = await submitContactMessage(message(), { ip: address });
    expect(!blocked.ok && blocked.error.code).toBe("rate_limited");
  });

  it("is refused while the contact form is turned off", { timeout: 60_000 }, async () => {
    await updateWebsiteSettings(owner, { ...EMPTY, supportEmail: "support@example.com", contactFormEnabled: false });
    const result = await submitContactMessage(message(), { ip: ip() });
    expect(!result.ok && result.error.code).toBe("unavailable");
    await updateWebsiteSettings(owner, { ...EMPTY, supportEmail: "support@example.com", contactFormEnabled: true });
  });
});

describe("stored contact messages", () => {
  it("only the platform owner can list them or change their status, which is audited", { timeout: 90_000 }, async () => {
    const input = message();
    await submitContactMessage(input, { ip: ip() });
    const [row] = await db.select().from(contactSubmissions).where(eq(contactSubmissions.email, input.email));

    for (const actor of [admin, plain]) {
      const list = await listContactSubmissions(actor);
      expect(!list.ok && list.error.code).toBe("forbidden");
      const change = await setContactSubmissionStatus(actor, row.id, "archived");
      expect(!change.ok && change.error.code).toBe("forbidden");
    }

    const list = await listContactSubmissions(owner, { status: "new" });
    expect(list.ok && list.rows.some((r) => r.id === row.id)).toBe(true);

    expect((await setContactSubmissionStatus(owner, row.id, "read")).ok).toBe(true);
    const [after] = await db.select().from(contactSubmissions).where(eq(contactSubmissions.id, row.id));
    expect(after.status).toBe("read");
    expect(after.reviewedBy).toBe(owner.userId);

    const audits = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.entityId, row.id));
    expect(audits.map((a) => a.action)).toContain("updateContactSubmissionStatus");

    const missing = await setContactSubmissionStatus(owner, randomUUID(), "read");
    expect(!missing.ok && missing.error.code).toBe("not_found");
  });
});
