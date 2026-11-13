import { describe, expect, it } from "vitest";
import { resolveSiteUrl } from "./seo";

describe("resolveSiteUrl", () => {
  it("normalizes a valid URL to its origin", () => {
    expect(resolveSiteUrl("https://example.com", "production")).toBe("https://example.com");
    expect(resolveSiteUrl("https://example.com/", "production")).toBe("https://example.com");
    expect(resolveSiteUrl("  https://Example.com/some/path?q=1#top ", "production")).toBe("https://example.com");
    expect(resolveSiteUrl("http://localhost:3000/", "development")).toBe("http://localhost:3000");
  });

  it("requires a value in production", () => {
    expect(() => resolveSiteUrl(undefined, "production")).toThrow(/NEXT_PUBLIC_SITE_URL is required/);
    expect(() => resolveSiteUrl("   ", "production")).toThrow(/NEXT_PUBLIC_SITE_URL is required/);
  });

  it("falls back to localhost outside production when unset", () => {
    expect(resolveSiteUrl(undefined, "development")).toBe("http://localhost:3000");
    expect(resolveSiteUrl("", "test")).toBe("http://localhost:3000");
  });

  it("rejects invalid URLs in every environment", () => {
    expect(() => resolveSiteUrl("example.com", "production")).toThrow(/not a valid URL/);
    expect(() => resolveSiteUrl("not a url", "development")).toThrow(/not a valid URL/);
    expect(() => resolveSiteUrl("ftp://example.com", "production")).toThrow(/must use http or https/);
  });
});
