/**
 * What the student page's "Enrolled courses" row offers in its actions cell.
 * A course that belongs to a complete-program enrollment is managed by the
 * program ("Withdraw from program" on the program card), so it never gets a
 * per-course Withdraw; the server refuses that too (withdrawStudentFromBatch).
 * An individual course keeps Withdraw for members allowed to withdraw.
 */
export type CourseRowAction = "withdraw" | "managed_by_program" | "none";

export function courseRowAction(enrollment: { status: string; programEnrollmentId: string | null }, canWithdraw: boolean): CourseRowAction {
  if (!canWithdraw || enrollment.status !== "active") return "none";
  return enrollment.programEnrollmentId ? "managed_by_program" : "withdraw";
}
