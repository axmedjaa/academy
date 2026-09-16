import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { attemptSignIn } from "./sign-in";

const PASSWORD = "correct-horse-battery-staple";

let activeUserId: string;
let activeUserEmail: string;
let disabledUserId: string;

beforeAll(async () => {
  const passwordHash = await hashPassword(PASSWORD);

  activeUserEmail = `signin-test-${randomUUID()}@example.com`;
  const [active] = await db
    .insert(users)
    .values({ email: activeUserEmail, passwordHash })
    .returning({ id: users.id });
  activeUserId = active.id;

  const [disabled] = await db
    .insert(users)
    .values({
      email: `signin-test-disabled-${randomUUID()}@example.com`,
      passwordHash,
      status: "disabled",
    })
    .returning({ id: users.id });
  disabledUserId = disabled.id;
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, activeUserId));
  await db.delete(users).where(eq(users.id, disabledUserId));
});

describe("attemptSignIn", () => {
  it("succeeds with correct email/password and identifies the user", async () => {
    const result = await attemptSignIn(activeUserEmail, PASSWORD);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.userId).toBe(activeUserId);
    }
  });

  it("is case-insensitive on email", async () => {
    const result = await attemptSignIn(activeUserEmail.toUpperCase(), PASSWORD);
    expect(result.ok).toBe(true);
  });

  it("rejects a wrong password with a generic message", async () => {
    const result = await attemptSignIn(activeUserEmail, "totally-wrong-password");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("Invalid email or password.");
    }
  });

  it("rejects a nonexistent email with the same generic message", async () => {
    const result = await attemptSignIn(
      "no-such-user@example.com",
      "whatever-password-here",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("Invalid email or password.");
    }
  });

  it("rejects a disabled account even with the correct password", async () => {
    const [disabledUser] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, disabledUserId));

    const result = await attemptSignIn(disabledUser.email, PASSWORD);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("Invalid email or password.");
    }
  });
});
