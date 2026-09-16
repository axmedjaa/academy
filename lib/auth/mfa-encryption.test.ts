import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./mfa-encryption";

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a secret", () => {
    const secret = "JBSWY3DPEHPK3PXP";
    const encrypted = encryptSecret(secret);
    expect(encrypted).not.toBe(secret);
    expect(decryptSecret(encrypted)).toBe(secret);
  });

  it("produces different ciphertext each time (random IV)", () => {
    const secret = "JBSWY3DPEHPK3PXP";
    expect(encryptSecret(secret)).not.toBe(encryptSecret(secret));
  });

  it("fails to decrypt tampered ciphertext (auth tag mismatch)", () => {
    const encrypted = encryptSecret("JBSWY3DPEHPK3PXP");
    const tampered = Buffer.from(encrypted, "base64");
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => decryptSecret(tampered.toString("base64"))).toThrow();
  });
});
