import { describe, expect, it } from "vitest";
import { checkEmailHealth, checkSmsHealth, checkStorageHealth } from "./provider-health";

describe("provider-health placeholders", () => {
  it("checkStorageHealth honestly reports unknown/not-implemented rather than a fabricated status", async () => {
    const result = await checkStorageHealth();

    expect(result.provider).toBe("storage");
    expect(result.status).toBe("unknown");
    expect(result.reason).toMatch(/lib\/storage/);
    expect(result.reason).toMatch(/not yet implemented/i);
  });

  it("checkEmailHealth honestly reports unknown/not-implemented rather than a fabricated status", async () => {
    const result = await checkEmailHealth();

    expect(result.provider).toBe("email");
    expect(result.status).toBe("unknown");
    expect(result.reason).toMatch(/lib\/email/);
    expect(result.reason).toMatch(/not yet implemented/i);
  });

  it("checkSmsHealth honestly reports unknown/not-implemented rather than a fabricated status", async () => {
    const result = await checkSmsHealth();

    expect(result.provider).toBe("sms");
    expect(result.status).toBe("unknown");
    expect(result.reason).toMatch(/lib\/sms/);
    expect(result.reason).toMatch(/not yet implemented/i);
  });

  it("never reports a healthy/unhealthy status — only ever the honest unknown placeholder", async () => {
    const results = await Promise.all([checkStorageHealth(), checkEmailHealth(), checkSmsHealth()]);

    for (const result of results) {
      expect(result.status).toBe("unknown");
    }
  });
});
