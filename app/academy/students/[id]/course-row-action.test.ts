import { describe, expect, it } from "vitest";
import { courseRowAction } from "./course-row-action";

/** The student page's Enrolled courses row: which action it offers. */
describe("courseRowAction (student page, Enrolled courses)", () => {
  const programCourse = { status: "active", programEnrollmentId: "5fbbda3e-47e1-458e-aa1b-6104389cde13" };
  const individualCourse = { status: "active", programEnrollmentId: null };

  it("a program-linked course never offers Withdraw; it is managed by the program", () => {
    expect(courseRowAction(programCourse, true)).toBe("managed_by_program");
  });

  it("an individually enrolled course keeps Withdraw for a member allowed to withdraw", () => {
    expect(courseRowAction(individualCourse, true)).toBe("withdraw");
  });

  it("nothing is offered without withdraw rights, or on a course that is no longer active", () => {
    expect(courseRowAction(individualCourse, false)).toBe("none");
    expect(courseRowAction(programCourse, false)).toBe("none");
    expect(courseRowAction({ status: "withdrawn", programEnrollmentId: null }, true)).toBe("none");
    expect(courseRowAction({ status: "completed", programEnrollmentId: "x" }, true)).toBe("none");
  });
});
