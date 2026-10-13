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

  /**
   * Security regression test (CWE-208, account enumeration via timing).
   * Before the fix, a nonexistent email returned as soon as the `users`
   * lookup came back empty — skipping Argon2id entirely — while an
   * existing account with a wrong password always paid for one real
   * `verifyPassword` call. Measured directly against this project's own
   * Neon instance: a consistent ~90-115ms gap (nonexistent ~209ms median,
   * wrong-password ~325ms median), reliably distinguishable above normal
   * network jitter. The fix (lib/auth/password.ts's `verifyAgainstDummyHash`)
   * makes the "no such user" path pay for one dummy Argon2id verification
   * too, with the same cost parameters, closing the gap to a few ms.
   *
   * Asserts the *median of the per-iteration paired differences* stays
   * under a generous 70ms. Paired (same iteration's two calls, taken
   * back-to-back) rather than comparing two independently-computed
   * medians: a shared ambient-load spike (another process on the same
   * machine, a slow Neon round trip) inflates both of a pair's calls
   * together, which cancels out of their difference — comparing two
   * separately-aggregated series doesn't cancel that correlation as
   * cleanly, and did measure one flaky 79ms gap under concurrent system
   * load (a production build running at the same time) despite the
   * underlying fix being unaffected. 20 samples (not 10) for a sturdier
   * median on top of that. 70ms stays comfortably above the ~10-15ms
   * typical post-fix gap and comfortably below the ~90-115ms gap this
   * test would have measured before the fix, so it still fails on a true
   * regression without chasing ordinary network/system noise.
   */
  it(
    "takes approximately the same time for a nonexistent email as a wrong password (no timing-based account enumeration)",
    async () => {
      const SAMPLES = 20;
      const median = (values: number[]): number => {
        const sorted = [...values].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)];
      };

      const pairedDifferences: number[] = [];

      for (let i = 0; i < SAMPLES; i++) {
        const startA = performance.now();
        await attemptSignIn(`no-such-user-${randomUUID()}@example.com`, "whatever-password-here");
        const nonexistentTime = performance.now() - startA;

        const startB = performance.now();
        await attemptSignIn(activeUserEmail, "totally-wrong-password");
        const wrongPasswordTime = performance.now() - startB;

        pairedDifferences.push(Math.abs(wrongPasswordTime - nonexistentTime));
      }

      expect(median(pairedDifferences)).toBeLessThan(70);
    },
    60_000,
  );
});
