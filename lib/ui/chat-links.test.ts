import { describe, expect, it } from "vitest";
import { chatLinks } from "./chat-links";

describe("chatLinks", () => {
  it("builds WhatsApp and Telegram links from an international number", () => {
    expect(chatLinks("+252 63 400 0101")).toEqual({
      ok: true,
      whatsapp: "https://wa.me/252634000101",
      telegram: "https://t.me/+252634000101",
    });
  });

  it("accepts the 00 international prefix", () => {
    const links = chatLinks("00252-63-400-0101");
    expect(links.ok && links.whatsapp).toBe("https://wa.me/252634000101");
  });

  it("reports a missing number", () => {
    expect(chatLinks(null)).toEqual({ ok: false, reason: "missing" });
    expect(chatLinks("   ")).toEqual({ ok: false, reason: "missing" });
  });

  it("refuses numbers without a country code instead of guessing one", () => {
    expect(chatLinks("063 400 0101")).toEqual({ ok: false, reason: "not-international" });
    expect(chatLinks("634000101")).toEqual({ ok: false, reason: "not-international" });
  });

  it("refuses numbers that are too short or too long", () => {
    expect(chatLinks("+252 63")).toEqual({ ok: false, reason: "not-international" });
    expect(chatLinks("+1234567890123456")).toEqual({ ok: false, reason: "not-international" });
  });
});
