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

describe("sendEmail — permanent vs temporary failures", () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = "test-key";
    process.env.EMAIL_FROM = "no-reply@example.com";
  });

  it("marks a 403 (Resend's unverified-domain sandbox restriction) as permanent, with its status code", async () => {
    sendMock.mockResolvedValue({
      data: null,
      error: { name: "validation_error", statusCode: 403, message: "You can only send testing emails to your own email address." },
    });
    const result = await sendEmail({ to: "user@example.com", subject: "s", html: "h", text: "t" });
    expect(result).toMatchObject({ ok: false, permanent: true, statusCode: 403 });
  });

  it.each([429, 500, 503])("keeps %i retryable", async (statusCode) => {
    sendMock.mockResolvedValue({ data: null, error: { name: "x", statusCode, message: "try later" } });
    const result = await sendEmail({ to: "user@example.com", subject: "s", html: "h", text: "t" });
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("permanent");
  });

  it("keeps a thrown network error retryable", async () => {
    sendMock.mockRejectedValue(new Error("network down"));
    const result = await sendEmail({ to: "user@example.com", subject: "s", html: "h", text: "t" });
    expect(result).not.toHaveProperty("permanent");
  });

  it("treats missing configuration as permanent", async () => {
    delete process.env.RESEND_API_KEY;
    const result = await sendEmail({ to: "user@example.com", subject: "s", html: "h", text: "t" });
    expect(result).toMatchObject({ ok: false, permanent: true });
  });

  it("logs only the recipient's domain, never the full address", async () => {
    sendMock.mockResolvedValueOnce({ data: { id: "a" }, error: null });
    await sendEmail({ to: "person.name@example.com", subject: "s", html: "h", text: "t" });
    sendMock.mockResolvedValueOnce({ data: null, error: { name: "x", statusCode: 403, message: "no" } });
    await sendEmail({ to: "person.name@example.com", subject: "s", html: "h", text: "t" });
    const logged = JSON.stringify([...vi.mocked(logger.error).mock.calls, ...vi.mocked(logger.info).mock.calls]);
    expect(logged).not.toContain("person.name");
    expect(logged).toContain("<redacted>@example.com");
  });
});

describe("sendEmail — idempotency key (notification worker)", () => {
  it("forwards the idempotency key to Resend when given", async () => {
    process.env.RESEND_API_KEY = "test-key";
    process.env.EMAIL_FROM = "App <no-reply@example.com>";
    sendMock.mockResolvedValue({ data: { id: "abc" }, error: null });

    const result = await sendEmail({ to: "user@example.com", subject: "s", html: "<p>h</p>", text: "t" }, { idempotencyKey: "notification-123" });

    expect(result.ok).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][1]).toEqual({ idempotencyKey: "notification-123" });
  });

  it("calls Resend with a single argument when no key is given (existing direct flows unchanged)", async () => {
    process.env.RESEND_API_KEY = "test-key";
    process.env.EMAIL_FROM = "App <no-reply@example.com>";
    sendMock.mockResolvedValue({ data: { id: "abc" }, error: null });

    await sendEmail({ to: "user@example.com", subject: "s", html: "<p>h</p>", text: "t" });

    expect(sendMock.mock.calls[0]).toHaveLength(1);
  });
});
