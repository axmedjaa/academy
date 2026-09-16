import { describe, expect, it } from "vitest";
import { hashPassword, passwordSchema, verifyPassword } from "./password";

describe("hashPassword / verifyPassword", () => {
  it("round-trips: a hashed password verifies against the original", async () => {
    const password = "correct-horse-battery-staple";
    const hash = await hashPassword(password);

    expect(hash).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword(hash, password)).resolves.toBe(true);
  });

  it("rejects an incorrect password against a valid hash", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    await expect(verifyPassword(hash, "wrong-password-entirely")).resolves.toBe(
      false,
    );
  });

  it("produces a different hash each time (random salt)", async () => {
    const password = "correct-horse-battery-staple";
    const [hashA, hashB] = await Promise.all([
      hashPassword(password),
      hashPassword(password),
    ]);

    expect(hashA).not.toBe(hashB);
  });
});

describe("passwordSchema", () => {
  it("rejects passwords under 12 characters", () => {
    expect(passwordSchema.safeParse("short1234567".slice(0, 11)).success).toBe(
      false,
    );
  });

  it("accepts passwords of exactly 12 characters", () => {
    expect(passwordSchema.safeParse("123456789012").success).toBe(true);
  });

  it("accepts passwords over 12 characters", () => {
    expect(passwordSchema.safeParse("a-very-long-password-here").success).toBe(
      true,
    );
  });
});
