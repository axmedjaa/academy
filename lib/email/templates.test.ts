import { describe, expect, it } from "vitest";
import { passwordResetEmail, verifyEmailChangeEmail } from "./templates";

describe("passwordResetEmail", () => {
  it("has the exact required subject", () => {
    const content = passwordResetEmail({ resetUrl: "https://app.example.com/reset-password?token=abc", expiresInMinutes: 60 });
    expect(content.subject).toBe("Reset your password");
  });

  it("includes the reset URL and expiry, and never mentions passwords/DB info", () => {
    const resetUrl = "https://app.example.com/reset-password?token=abc123";
    const content = passwordResetEmail({ resetUrl, expiresInMinutes: 45 });

    expect(content.html).toContain(resetUrl);
    expect(content.text).toContain(resetUrl);
    expect(content.html).toMatch(/45 minutes/);
    expect(content.text).toMatch(/45 minutes/);
    expect(content.html.toLowerCase()).not.toContain("password_hash");
    expect(content.html.toLowerCase()).not.toContain("select * from");
  });

  it("includes an 'if you didn't request this' warning", () => {
    const content = passwordResetEmail({ resetUrl: "https://app.example.com/x", expiresInMinutes: 60 });
    expect(content.html.toLowerCase()).toContain("didn't request");
    expect(content.text.toLowerCase()).toContain("didn't request");
  });
});

describe("verifyEmailChangeEmail", () => {
  it("has the exact required subject", () => {
    const content = verifyEmailChangeEmail({ verifyUrl: "https://app.example.com/account/verify-email?token=abc", expiresInMinutes: 60 });
    expect(content.subject).toBe("Verify your new email address");
  });

  it("includes the verification URL and expiry", () => {
    const verifyUrl = "https://app.example.com/account/verify-email?token=xyz789";
    const content = verifyEmailChangeEmail({ verifyUrl, expiresInMinutes: 30 });

    expect(content.html).toContain(verifyUrl);
    expect(content.text).toContain(verifyUrl);
    expect(content.html).toMatch(/30 minutes/);
  });

  it("includes an 'if you didn't request this' warning", () => {
    const content = verifyEmailChangeEmail({ verifyUrl: "https://app.example.com/x", expiresInMinutes: 60 });
    expect(content.html.toLowerCase()).toContain("didn't request");
    expect(content.text.toLowerCase()).toContain("didn't request");
  });
});
