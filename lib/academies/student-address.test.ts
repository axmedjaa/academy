import { describe, expect, it } from "vitest";
import { updateStudentSchema } from "./students";
import { registerStudentSchema } from "./register-student";

// Schema-only checks (no database access).
describe("student address and district", () => {
  const base = { fullName: "Amina Hassan" };

  it("keeps stored values when a caller doesn't send the fields", () => {
    const parsed = updateStudentSchema.parse(base);
    expect(parsed.address).toBeUndefined();
    expect(parsed.district).toBeUndefined();
  });

  it("clears with an empty value and trims real ones", () => {
    const parsed = updateStudentSchema.parse({ ...base, address: "  ", district: " Hargeisa " });
    expect(parsed.address).toBeNull();
    expect(parsed.district).toBe("Hargeisa");
  });

  it("rejects values that are too long", () => {
    expect(updateStudentSchema.safeParse({ ...base, address: "x".repeat(501) }).success).toBe(false);
    expect(updateStudentSchema.safeParse({ ...base, district: "x".repeat(121) }).success).toBe(false);
  });

  it("accepts both on registration", () => {
    const parsed = registerStudentSchema.parse({
      ...base,
      branchId: "7d1f4c63-6f0b-4a3c-9a43-2c1b0f8e9a10",
      address: "Independence Ave",
      district: "Hargeisa",
    });
    expect(parsed.address).toBe("Independence Ave");
    expect(parsed.district).toBe("Hargeisa");
  });
});
