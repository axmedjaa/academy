import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { redis } from "@/lib/redis";
import { checkMfaEnrollmentRateLimit } from "./mfa-enrollment-rate-limit";

let testUserId: string;

afterEach(async () => {
  await redis.del(`ratelimit:mfa-enrollment:${testUserId}`);
});

describe("checkMfaEnrollmentRateLimit", () => {
  it("allows attempts up to the default limit (5), then blocks", async () => {
    testUserId = randomUUID();

    for (let i = 0; i < 5; i++) {
      const result = await checkMfaEnrollmentRateLimit(testUserId);
      expect(result.allowed).toBe(true);
    }

    const blocked = await checkMfaEnrollmentRateLimit(testUserId);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("is keyed per userId — one user's attempts never block a different user", async () => {
    testUserId = randomUUID();
    const otherUserId = randomUUID();

    for (let i = 0; i < 6; i++) {
      await checkMfaEnrollmentRateLimit(testUserId);
    }
    const blockedForFirstUser = await checkMfaEnrollmentRateLimit(testUserId);
    const allowedForOtherUser =
      await checkMfaEnrollmentRateLimit(otherUserId);

    expect(blockedForFirstUser.allowed).toBe(false);
    expect(allowedForOtherUser.allowed).toBe(true);

    await redis.del(`ratelimit:mfa-enrollment:${otherUserId}`);
  });
});
