import { describe, expect, it } from "vitest";
import { resolveClientIp } from "./client-ip";

/**
 * Security regression tests (Priority 1 — "verify production proxy
 * trust"). Covers both halves of the fix:
 *
 * 1. No trusted hop configured (hopCount <= 0) -> never trust the header
 *    at all, regardless of what it contains.
 * 2. A trusted hop count configured -> read from the *right* end of the
 *    list (what a trusted hop actually appended), never the left end
 *    (what the original, unauthenticated client could have claimed) —
 *    this is the part the previous three-times-duplicated
 *    `split(",")[0]` implementation got backwards for the common
 *    "proxy appends" deployment shape.
 */
describe("resolveClientIp", () => {
  it("never trusts the header when no hop count is configured (default)", () => {
    expect(resolveClientIp("1.2.3.4", 0)).toBe("unknown");
    expect(resolveClientIp("1.2.3.4, 5.6.7.8", 0)).toBe("unknown");
    expect(resolveClientIp(null, 0)).toBe("unknown");
  });

  it("never trusts the header for a negative hop count", () => {
    expect(resolveClientIp("1.2.3.4", -1)).toBe("unknown");
  });

  it("returns unknown when the header is missing, even with a configured hop count", () => {
    expect(resolveClientIp(null, 1)).toBe("unknown");
  });

  it("with one trusted hop, returns the LAST entry, not the first", () => {
    // A trusted single hop appends the real client's IP as the last
    // entry, regardless of whatever the client itself put in front of
    // it. The attacker-supplied "1.2.3.4" here must never be returned.
    expect(resolveClientIp("1.2.3.4, 9.9.9.9", 1)).toBe("9.9.9.9");
  });

  it("with two trusted hops, returns the SECOND-TO-LAST entry", () => {
    // hop1 appended the real client IP (9.9.9.9); hop2 then appended
    // hop1's own address (8.8.8.8) when forwarding onward.
    expect(resolveClientIp("1.2.3.4, 9.9.9.9, 8.8.8.8", 2)).toBe("9.9.9.9");
  });

  it("a spoofed, longer forged prefix still can't move the real entry", () => {
    // However many fake entries the client prepends, a single trusted
    // hop still only ever appends exactly one real entry at the end.
    expect(resolveClientIp("fake1, fake2, fake3, fake4, REAL_IP", 1)).toBe("REAL_IP");
  });

  it("falls back to unknown when the configured hop count exceeds the entries present", () => {
    // Misconfiguration (hopCount doesn't match the real topology) must
    // never cause a guess — it must fail to the same safe default as no
    // configuration at all.
    expect(resolveClientIp("1.2.3.4", 2)).toBe("unknown");
    expect(resolveClientIp("1.2.3.4", 5)).toBe("unknown");
  });

  it("trims whitespace around entries", () => {
    expect(resolveClientIp("1.2.3.4 ,  9.9.9.9  ", 1)).toBe("9.9.9.9");
  });

  it("ignores empty segments from malformed headers", () => {
    expect(resolveClientIp("1.2.3.4,,9.9.9.9", 1)).toBe("9.9.9.9");
  });
});
