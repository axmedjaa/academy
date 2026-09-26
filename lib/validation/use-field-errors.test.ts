import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseFieldErrors } from "./use-field-errors";

const schema = z.object({
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

describe("parseFieldErrors", () => {
  it("returns null when every field is valid", () => {
    expect(parseFieldErrors(schema, { email: "a@example.com", password: "12345678" })).toBeNull();
  });

  it("returns one message per invalid field, keyed by field name", () => {
    const errors = parseFieldErrors(schema, { email: "not-an-email", password: "short" });
    expect(errors).toEqual({
      email: "Enter a valid email address",
      password: "Password must be at least 8 characters",
    });
  });

  it("only reports the first issue per field, not every one", () => {
    const multiIssue = z.object({ password: z.string().min(8).max(4) });
    const errors = parseFieldErrors(multiIssue, { password: "abc" });
    expect(Object.keys(errors ?? {})).toEqual(["password"]);
  });

  it("attaches a .refine()'s message to the field named in its explicit path", () => {
    const refined = z
      .object({ password: z.string(), confirmPassword: z.string() })
      .refine((data) => data.password === data.confirmPassword, {
        message: "Passwords do not match",
        path: ["confirmPassword"],
      });
    const errors = parseFieldErrors(refined, { password: "a", confirmPassword: "b" });
    expect(errors).toEqual({ confirmPassword: "Passwords do not match" });
  });

  it("keys a form-level .refine() with no explicit path under '_form'", () => {
    const refined = z
      .object({ password: z.string(), confirmPassword: z.string() })
      .refine((data) => data.password === data.confirmPassword, { message: "Passwords do not match" });
    const errors = parseFieldErrors(refined, { password: "a", confirmPassword: "b" });
    expect(errors).toEqual({ _form: "Passwords do not match" });
  });
});
