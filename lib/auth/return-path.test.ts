import { describe, expect, it } from "vitest";
import { isWellFormedInvitationToken, sanitizeReturnPath } from "./return-path";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"; // 43 chars

describe("sanitizeReturnPath — accepted internal paths", () => {
  it.each([
    [`/staff-invitation?token=${TOKEN}`, `/staff-invitation?token=${TOKEN}`],
    ["/staff-invitation", "/staff-invitation"],
    ["/academy/dashboard", "/academy/dashboard"],
    ["/academy/students?q=ali", "/academy/students?q=ali"],
    ["/platform/academies", "/platform/academies"],
    ["/account/security", "/account/security"],
    ["/academy/staff#pending", "/academy/staff"], // fragment dropped
  ])("%s -> %s", (input, expected) => {
    expect(sanitizeReturnPath(input)).toBe(expected);
  });
});

describe("sanitizeReturnPath — rejected destinations", () => {
  it.each([
    // External and scheme-bearing URLs
    "https://evil.example/academy",
    "http://evil.example",
    "javascript:alert(1)",
    "data:text/html,hi",
    // Protocol-relative and backslash tricks
    "//evil.example",
    "//evil.example/staff-invitation",
    "/\\evil.example",
    "\\\\evil.example",
    "/staff-invitation\\..\\..\\evil",
    // Encoded slashes/backslashes
    "/%2F%2Fevil.example",
    "/%5Cevil.example",
    "/academy/%2e%2e%2f%2e%2e%2flogin",
    // Whitespace and control characters
    " /academy",
    "/academy\n/evil",
    "/acad\temy",
    "/academy\u0000",
    // Paths outside the allowlist (including after dot-segment normalization)
    "/login",
    "/",
    "/api/health",
    "/academy-evil",
    "/staff-invitationx",
    "/academy/../login",
    "/staff-invitation/../../evil",
    // Malformed / wrong types
    "",
    "academy/dashboard",
    `/${"a".repeat(1100)}`,
  ])("rejects %j", (input) => {
    expect(sanitizeReturnPath(input)).toBeNull();
  });

  it.each([null, undefined, 42, {}, ["/academy"]])("rejects non-string %j", (input) => {
    expect(sanitizeReturnPath(input)).toBeNull();
  });
});

describe("isWellFormedInvitationToken", () => {
  it("accepts a 43-character base64url token", () => {
    expect(isWellFormedInvitationToken(TOKEN)).toBe(true);
  });
  it.each(["", "short", `${TOKEN}x`, `${TOKEN.slice(0, 42)}/`, `${TOKEN.slice(0, 40)}&a=`])("rejects %j", (token) => {
    expect(isWellFormedInvitationToken(token)).toBe(false);
  });
});
