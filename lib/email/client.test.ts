import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the vi.mock factory below (itself hoisted by Vitest to the top
// of the file) can share the same mock function references as the test
// bodies. Nothing in this file ever calls the real Resend HTTP API.
const { sendMock, resendCtorMock } = vi.hoisted(() => {
  const sendMock = vi.fn();
  const resendCtorMock = vi.fn(function ResendMock(this: { emails: { send: typeof sendMock } }) {
    this.emails = { send: sendMock };
  });
  return { sendMock, resendCtorMock };
});

vi.mock("resend", () => ({ Resend: resendCtorMock }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
}));

import { logger } from "@/lib/logger";
import { sendEmail } from "./client";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  sendMock.mockReset();
  resendCtorMock.mockClear();
  vi.mocked(logger.error).mockClear();
  vi.mocked(logger.info).mockClear();
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("sendEmail", () => {
  it("fails safely and never touches Resend when RESEND_API_KEY is missing", async () => {
    process.env.EMAIL_FROM = "no-reply@example.com";
    const result = await sendEmail({ to: "user@example.com", subject: "s", html: "<p>h</p>", text: "t" });
    expect(result.ok).toBe(false);
    expect(resendCtorMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("fails safely and never touches Resend when EMAIL_FROM is missing", async () => {
    process.env.RESEND_API_KEY = "test-key";
    const result = await sendEmail({ to: "user@example.com", subject: "s", html: "<p>h</p>", text: "t" });
    expect(result.ok).toBe(false);
    expect(resendCtorMock).not.toHaveBeenCalled();
  });

  it("sends via Resend with the exact fields given when configured", async () => {
    process.env.RESEND_API_KEY = "test-key";
    process.env.EMAIL_FROM = "App <no-reply@example.com>";
    sendMock.mockResolvedValue({ data: { id: "abc" }, error: null });

    const result = await sendEmail({
      to: "user@example.com",
      subject: "Reset your password",
      html: "<p>link</p>",
      text: "link",
    });

    expect(result.ok).toBe(true);
    expect(sendMock).toHaveBeenCalledWith({
      from: "App <no-reply@example.com>",
      to: "user@example.com",
      subject: "Reset your password",
      html: "<p>link</p>",
      text: "link",
    });
  });

  it("returns a safe error without the provider's raw message when Resend reports an error", async () => {
    process.env.RESEND_API_KEY = "test-key";
    process.env.EMAIL_FROM = "no-reply@example.com";
    sendMock.mockResolvedValue({ data: null, error: { message: "invalid api key: sk_live_abc123" } });

    const result = await sendEmail({ to: "user@example.com", subject: "s", html: "h", text: "t" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain("sk_live_abc123");
    }
  });

  it("catches a thrown/network error instead of propagating it", async () => {
    process.env.RESEND_API_KEY = "test-key";
    process.env.EMAIL_FROM = "no-reply@example.com";
    sendMock.mockRejectedValue(new Error("network down"));

    await expect(
      sendEmail({ to: "user@example.com", subject: "s", html: "h", text: "t" }),
    ).resolves.toEqual({ ok: false, error: expect.any(String) });
  });

  it("never logs the API key or the email body (which may embed a one-time token)", async () => {
    process.env.RESEND_API_KEY = "super-secret-resend-key";
    process.env.EMAIL_FROM = "no-reply@example.com";
    sendMock.mockResolvedValue({ data: null, error: { message: "boom" } });

    await sendEmail({
      to: "user@example.com",
      subject: "Reset your password",
      html: "<a href='https://app.example.com/reset-password?token=super-secret-reset-token'>reset</a>",
      text: "https://app.example.com/reset-password?token=super-secret-reset-token",
    });

    const logged = JSON.stringify([
      ...vi.mocked(logger.error).mock.calls,
      ...vi.mocked(logger.info).mock.calls,
    ]);
    expect(logged).not.toContain("super-secret-resend-key");
    expect(logged).not.toContain("super-secret-reset-token");
  });
});
