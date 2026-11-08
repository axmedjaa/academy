import { describe, expect, it } from "vitest";
import { maskEmail } from "./mask-email";

describe("maskEmail", () => {
  it("keeps the first two characters of the name and the whole domain", () => {
    expect(maskEmail("adnan@gmail.com")).toBe("ad***@gmail.com");
  });

  it("keeps only one character of a very short name", () => {
    expect(maskEmail("ab@example.com")).toBe("a***@example.com");
    expect(maskEmail("a@example.com")).toBe("a***@example.com");
  });

  it("never echoes a malformed value", () => {
    expect(maskEmail("not-an-email")).toBe("***");
    expect(maskEmail("@example.com")).toBe("***");
  });
});
