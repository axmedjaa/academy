import { describe, expect, it } from "vitest";
import { notificationEmailContent } from "./email-content";
import { NOTIFICATION_TEMPLATE_IDS } from "./templates";

describe("notificationEmailContent", () => {
  it.each(NOTIFICATION_TEMPLATE_IDS)("%s has a subject, plain-text and HTML body", (templateId) => {
    const content = notificationEmailContent(templateId, { academyName: "Hilltop Academy", appUrl: "https://app.example.test/" });
    expect(content.subject.length).toBeGreaterThan(0);
    expect(content.subject).not.toMatch(/[\r\n]/);
    expect(content.text.length).toBeGreaterThan(0);
    expect(content.html).toContain("<!doctype html>");
    expect(content.text).toContain("https://app.example.test/");
  });

  it("escapes the academy name in HTML (it is entered by academy staff)", () => {
    const content = notificationEmailContent("result.published", { academyName: '<script>alert("x")</script>', appUrl: "https://app.example.test" });
    expect(content.html).not.toContain("<script>");
    expect(content.html).toContain("&lt;script&gt;");
  });

  it("falls back to 'your academy', capitalized at the start of a sentence", () => {
    const content = notificationEmailContent("academy.activation", { academyName: null, appUrl: null });
    expect(content.text).toBe("Your academy is now active on Dardar School System.");
  });

  it("omits the link when APP_URL is not configured", () => {
    const content = notificationEmailContent("result.published", { academyName: "A", appUrl: undefined });
    expect(content.text).not.toContain("http");
    expect(content.html).not.toContain("href=");
  });

  it("points the new-device notice at password reset", () => {
    const content = notificationEmailContent("security.new_device_signin", { appUrl: "https://app.example.test" });
    expect(content.text).toContain("https://app.example.test/forgot-password");
  });
});
