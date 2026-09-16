import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPendingMfaToken, verifyPendingMfaToken } from "./mfa-pending";

afterEach(() => {
  vi.useRealTimers();
});

describe("createPendingMfaToken / verifyPendingMfaToken", () => {
  it("round-trips a userId", () => {
    const userId = randomUUID();
    const token = createPendingMfaToken(userId);
    expect(verifyPendingMfaToken(token)).toEqual({ userId });
  });

  it("rejects a tampered payload", () => {
    const token = createPendingMfaToken(randomUUID());
    const [, signature] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ userId: randomUUID(), exp: Date.now() + 60_000 }),
    ).toString("base64url");
    expect(
      verifyPendingMfaToken(`${tamperedPayload}.${signature}`),
    ).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const token = createPendingMfaToken(randomUUID());
    const [payload] = token.split(".");
    expect(verifyPendingMfaToken(`${payload}.not-a-real-signature`)).toBeNull();
  });

  it("rejects a malformed token", () => {
    expect(verifyPendingMfaToken("not-a-token-at-all")).toBeNull();
    expect(verifyPendingMfaToken("")).toBeNull();
  });

  it("rejects an expired token", () => {
    vi.useFakeTimers();
    const userId = randomUUID();
    const token = createPendingMfaToken(userId);

    expect(verifyPendingMfaToken(token)).toEqual({ userId });

    vi.advanceTimersByTime(11 * 60 * 1000); // past the 10-minute TTL

    expect(verifyPendingMfaToken(token)).toBeNull();
  });
});
