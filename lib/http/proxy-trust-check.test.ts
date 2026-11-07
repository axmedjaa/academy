import { describe, expect, it } from "vitest";
import { checkProxyTrustConfig } from "./proxy-trust-check";

describe("checkProxyTrustConfig (SEC-M-02)", () => {
  it("production refuses an unset, empty, zero or malformed hop count", () => {
    for (const value of [undefined, "", "  ", "0", "-1", "1.5", "abc"]) {
      expect(checkProxyTrustConfig({ NODE_ENV: "production", TRUSTED_PROXY_HOP_COUNT: value }).ok).toBe(false);
    }
  });

  it("production accepts a positive whole number", () => {
    expect(checkProxyTrustConfig({ NODE_ENV: "production", TRUSTED_PROXY_HOP_COUNT: "1" })).toEqual({ ok: true });
    expect(checkProxyTrustConfig({ NODE_ENV: "production", TRUSTED_PROXY_HOP_COUNT: "2" })).toEqual({ ok: true });
  });

  it("development and test are never blocked", () => {
    expect(checkProxyTrustConfig({ NODE_ENV: "development" }).ok).toBe(true);
    expect(checkProxyTrustConfig({ NODE_ENV: "test" }).ok).toBe(true);
  });
});
