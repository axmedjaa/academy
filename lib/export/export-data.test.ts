import { randomUUID } from "node:crypto";
import { and, desc, eq, or } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  auditLogs,
  batches,
  batchTrainerAssignments,
  branches,
  courses,
  examResults,
  exams,
  expenseRecords,
  gradeConfigurations,
  incomeRecords,
  programs,
  staffProfiles,
  students,
  studentCharges,
  studentPayments,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import { getAcademyAuditLogs } from "@/lib/academies/audit-logs";
import { getAcademicReports } from "@/lib/academies/academic-reports";
import { getFinanceReports } from "@/lib/academies/finance-reports";
import { getStudentReports } from "@/lib/academies/student-reports";
import { searchStudents } from "@/lib/academies/students";
import { toCsv } from "./csv";
import {
  ACADEMIC_REPORT_COLUMNS,
  AUDIT_LOG_COLUMNS,
  exportData,
  FINANCE_REPORT_COLUMNS,
  flattenAcademicReport,
  flattenFinanceReport,
  flattenStudentReport,
  STUDENT_LIST_COLUMNS,
  STUDENT_REPORT_COLUMNS,
} from "./export-data";

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------
// toCsv — dedicated, DB-free unit tests
// ---------------------------------------------------------------------

describe("toCsv", () => {
  it("writes a header row from the first row's keys and one line per row", () => {
    const csv = toCsv([
      { a: 1, b: "x" },
      { a: 2, b: "y" },
    ]);
    expect(csv).toBe("a,b\n1,x\n2,y");
  });

  it("quotes a field containing a comma", () => {
    const csv = toCsv([{ name: "Smith, John" }]);
    expect(csv).toBe('name\n"Smith, John"');
  });

  it("quotes a field containing a double quote and doubles the embedded quote", () => {
    const csv = toCsv([{ note: 'He said "hi"' }]);
    expect(csv).toBe('note\n"He said ""hi"""');
  });

  it("quotes a field containing a newline", () => {
    const csv = toCsv([{ note: "line one\nline two" }]);
    expect(csv).toBe('note\n"line one\nline two"');
  });

  it("quotes a field containing a carriage return", () => {
    const csv = toCsv([{ note: "line one\rline two" }]);
    expect(csv).toBe('note\n"line one\rline two"');
  });

  it("renders null and undefined as an empty cell, never the text 'null'/'undefined'", () => {
    const csv = toCsv([{ a: null, b: undefined, c: 0 }]);
    expect(csv).toBe("a,b,c\n,,0");
  });

  it("formats a Date value as its ISO-8601 string", () => {
    const date = new Date("2026-01-15T10:30:00.000Z");
    const csv = toCsv([{ when: date }]);
    expect(csv).toBe(`when\n${date.toISOString()}`);
  });

  it("JSON-stringifies a plain object/array value", () => {
    const csv = toCsv([{ payload: { a: 1 } }, { payload: [1, 2] }]);
    expect(csv).toBe('payload\n"{""a"":1}"\n"[1,2]"');
  });

  it("with explicit columns: fixes order, fills a missing key with an empty cell, drops keys not listed", () => {
    const csv = toCsv([{ b: 2, extra: "dropped" }], ["a", "b"]);
    expect(csv).toBe("a,b\n,2");
  });

  it("with explicit columns and zero rows: still emits just the header line", () => {
    const csv = toCsv([], ["a", "b"]);
    expect(csv).toBe("a,b");
  });

  it("with no columns and zero rows: returns an empty string", () => {
    expect(toCsv([])).toBe("");
  });

  it("mixes rows of different shapes against one explicit column superset", () => {
    const csv = toCsv(
      [
        { section: "x", count: 1, label: null },
        { section: "y", count: null, label: "hi" },
      ],
      ["section", "count", "label"],
    );
    expect(csv).toBe("section,count,label\nx,1,\ny,,hi");
  });
});

// ---------------------------------------------------------------------
// exportData — real-Postgres integration tests
// ---------------------------------------------------------------------

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `export-data-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Export Data Test Plan ${randomUUID()}`,
      priceAmountCents: 1000,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 10,
      maxStudents: 100,
      maxStaff: 10,
      maxCourses: 10,
      maxStorageBytes: 1_073_741_824,
      reportsLevel: "basic",
    })
    .returning({ id: subscriptionPlans.id });
  createdPlanIds.push(plan.id);
  return plan.id;
}

async function createAcademy(creatorUserId: string): Promise<string> {
  const [academy] = await db
    .insert(academies)
    .values({
      name: `Export Data Test Academy ${randomUUID()}`,
      slug: `export-data-test-${randomUUID()}`,
      defaultCurrency: "USD",
      createdBy: creatorUserId,
    })
    .returning({ id: academies.id });
  createdAcademyIds.push(academy.id);
  return academy.id;
}

async function addMembership(userId: string, academyId: string, role: AcademyRole): Promise<void> {
  await db.insert(academyMemberships).values({ userId, academyId, role, status: "active" });
}

async function insertBranchDirect(academyId: string): Promise<string> {
  const code = `BR-${randomUUID().slice(0, 8)}`;
  const [row] = await db
    .insert(branches)
    .values({ academyId, name: `Branch ${code}`, code })
    .returning({ id: branches.id });
  return row.id;
}

async function insertStudentDirect(academyId: string, branchId: string, creatorUserId: string): Promise<string> {
  const [row] = await db
    .insert(students)
    .values({
      academyId,
      branchId,
      studentNumber: `STD-${randomUUID().slice(0, 8)}`,
      fullName: `Test Student ${randomUUID()}`,
      createdBy: creatorUserId,
    })
    .returning({ id: students.id });
  return row.id;
}

async function insertChargeDirect(
  academyId: string,
  studentId: string,
  creatorUserId: string,
  status: "open" | "partially_paid" | "paid" | "cancelled" = "open",
): Promise<void> {
  await db.insert(studentCharges).values({
    academyId,
    studentId,
    description: "Tuition",
    amountCents: 10_000,
    currency: "USD",
    status,
    createdBy: creatorUserId,
  });
}

async function insertPaymentDirect(
  academyId: string,
  studentId: string,
  recordedByUserId: string,
  status: "pending_approval" | "approved" | "rejected" | "reversed" = "approved",
): Promise<void> {
  await db.insert(studentPayments).values({
    academyId,
    studentId,
    amountCents: 5_000,
    currency: "USD",
    method: "cash",
    receivedAt: new Date(),
    recordedBy: recordedByUserId,
    status,
    approvedBy: status === "approved" ? recordedByUserId : undefined,
    approvedAt: status === "approved" ? new Date() : undefined,
  });
}

async function insertIncomeDirect(academyId: string, recordedBy: string): Promise<void> {
  await db.insert(incomeRecords).values({
    academyId,
    category: "Registration fees",
    amountCents: 20_000,
    currency: "USD",
    recordedBy,
    status: "posted",
  });
}

async function insertExpenseDirect(academyId: string, submittedBy: string): Promise<void> {
  await db.insert(expenseRecords).values({
    academyId,
    category: "Supplies",
    amountCents: 8_000,
    currency: "USD",
    submittedBy,
    status: "approved",
  });
}

async function insertProgramAndCourse(academyId: string): Promise<string> {
  const [program] = await db
    .insert(programs)
    .values({ academyId, name: `Program ${randomUUID()}` })
    .returning({ id: programs.id });
  const [course] = await db
    .insert(courses)
    .values({ academyId, programId: program.id, name: `Course ${randomUUID()}` })
    .returning({ id: courses.id });
  return course.id;
}

async function insertBatchDirect(academyId: string, branchId: string, courseId: string): Promise<string> {
  const [row] = await db
    .insert(batches)
    .values({ academyId, branchId, courseId, name: `Batch ${randomUUID()}`, code: `B-${randomUUID().slice(0, 8)}`, startDate: "2026-01-01" })
    .returning({ id: batches.id });
  return row.id;
}

async function insertGradeConfigDirect(academyId: string, creatorUserId: string): Promise<string> {
  const [row] = await db
    .insert(gradeConfigurations)
    .values({ academyId, name: `Config ${randomUUID()}`, createdBy: creatorUserId, status: "active" })
    .returning({ id: gradeConfigurations.id });
  return row.id;
}

async function insertExamDirect(academyId: string, batchId: string): Promise<string> {
  const [row] = await db
    .insert(exams)
    .values({ academyId, batchId, name: `Exam ${randomUUID()}`, maxMarks: "100", status: "completed" })
    .returning({ id: exams.id });
  return row.id;
}

async function insertPublishedResultDirect(
  academyId: string,
  examId: string,
  studentId: string,
  batchId: string,
  gradeConfigurationId: string,
  enteredBy: string,
  passFail: "pass" | "fail",
  gradeBandLabel: string,
): Promise<void> {
  await db.insert(examResults).values({
    academyId,
    examId,
    studentId,
    batchId,
    gradeConfigurationId,
    enteredBy,
    marksObtained: passFail === "pass" ? "80" : "20",
    passFail,
    gradeBandLabel,
    status: "published",
    publishedAt: new Date(),
  });
}

async function insertAuditLogDirect(
  academyId: string,
  overrides: Partial<typeof auditLogs.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(auditLogs)
    .values({ academyId, action: "test.action", entityType: "test-entity", result: "success", ...overrides })
    .returning({ id: auditLogs.id });
  return row.id;
}

async function setupAcademy(
  role: AcademyRole,
): Promise<{
  academyId: string;
  branchId: string;
  studentId: string;
  creatorUserId: string;
  userId: string;
  context: AuthContext;
}> {
  const creatorUserId = await createUser();
  const academyId = await createAcademy(creatorUserId);
  const planId = await createPlan();
  await db.insert(academySubscriptions).values({
    academyId,
    planId,
    status: "active",
    endsAt: new Date(Date.now() + 30 * DAY_MS),
    createdBy: creatorUserId,
  });
  const branchId = await insertBranchDirect(academyId);
  const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

  const userId = await createUser();
  await addMembership(userId, academyId, role);

  return {
    academyId,
    branchId,
    studentId,
    creatorUserId,
    userId,
    context: { userId, branchIds: [], academyWide: false },
  };
}

async function latestExportAuditRow(academyId: string, entityType: string) {
  const rows = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.academyId, academyId), eq(auditLogs.action, "data.export"), eq(auditLogs.entityType, entityType)))
    .orderBy(desc(auditLogs.createdAt))
    .limit(1);
  return rows[0];
}

afterAll(async () => {
  await db
    .delete(auditLogs)
    .where(
      or(
        ...createdAcademyIds.map((id) => eq(auditLogs.academyId, id)),
        ...createdUserIds.map((id) => eq(auditLogs.actorUserId, id)),
      ),
    );
  for (const academyId of createdAcademyIds) {
    await db.delete(examResults).where(eq(examResults.academyId, academyId));
    await db.delete(exams).where(eq(exams.academyId, academyId));
    await db.delete(gradeConfigurations).where(eq(gradeConfigurations.academyId, academyId));
    const batchRows = await db.select({ id: batches.id }).from(batches).where(eq(batches.academyId, academyId));
    for (const batch of batchRows) {
      await db.delete(batchTrainerAssignments).where(eq(batchTrainerAssignments.batchId, batch.id));
    }
    await db.delete(batches).where(eq(batches.academyId, academyId));
    await db.delete(courses).where(eq(courses.academyId, academyId));
    await db.delete(programs).where(eq(programs.academyId, academyId));
    await db.delete(studentCharges).where(eq(studentCharges.academyId, academyId));
    await db.delete(studentPayments).where(eq(studentPayments.academyId, academyId));
    await db.delete(incomeRecords).where(eq(incomeRecords.academyId, academyId));
    await db.delete(expenseRecords).where(eq(expenseRecords.academyId, academyId));
    await db.delete(students).where(eq(students.academyId, academyId));
    await db.delete(staffProfiles).where(eq(staffProfiles.academyId, academyId));
    await db.delete(branches).where(eq(branches.academyId, academyId));
    await db.delete(academySubscriptions).where(eq(academySubscriptions.academyId, academyId));
    await db.delete(academyMemberships).where(eq(academyMemberships.academyId, academyId));
  }
  for (const academyId of createdAcademyIds) {
    await db.delete(academies).where(eq(academies.id, academyId));
  }
  for (const planId of createdPlanIds) {
    await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, planId));
  }
  for (const userId of createdUserIds) {
    await db.delete(users).where(eq(users.id, userId));
  }
});

// ---------------------------------------------------------------------
// finance_report
// ---------------------------------------------------------------------

describe("exportData — finance_report", () => {
  it("returns the exact same rows getFinanceReports would, for a role with full visibility", async () => {
    const { academyId, studentId, creatorUserId, context } = await setupAcademy("academy_owner");
    await insertChargeDirect(academyId, studentId, creatorUserId, "open");
    await insertPaymentDirect(academyId, studentId, creatorUserId, "approved");
    await insertIncomeDirect(academyId, creatorUserId);
    await insertExpenseDirect(academyId, creatorUserId);

    const direct = await getFinanceReports(context);
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;
    const expectedRows = flattenFinanceReport(direct.report);
    const expectedCsv = toCsv(expectedRows, [...FINANCE_REPORT_COLUMNS]);

    const result = await exportData(context, "finance_report", {}, "csv");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rowCount).toBe(expectedRows.length);
    expect(result.content).toBe(expectedCsv);
    expect(result.content).toContain("studentPayments");
    expect(result.content).toContain("income");
    expect(result.content).toContain("expenses");
  });

  it("a role with no view rights on any finance section (admissions_officer) exports zero rows, never an error", async () => {
    const { academyId, studentId, creatorUserId, context } = await setupAcademy("admissions_officer");
    await insertIncomeDirect(academyId, creatorUserId);
    void studentId;

    const result = await exportData(context, "finance_report", {}, "csv");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rowCount).toBe(0);
    expect(result.content).toBe(toCsv([], [...FINANCE_REPORT_COLUMNS]));
  });

  it("a role with partial visibility (trainer: payments+expenses, not income) never exports the income section", async () => {
    const { academyId, studentId, creatorUserId, context } = await setupAcademy("trainer");
    await insertPaymentDirect(academyId, studentId, creatorUserId, "approved");
    await insertIncomeDirect(academyId, creatorUserId);
    await insertExpenseDirect(academyId, creatorUserId);

    const direct = await getFinanceReports(context);
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;
    expect(direct.report.income.visible).toBe(false);

    const result = await exportData(context, "finance_report", {}, "csv");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).not.toContain("\nincome,");
    expect(result.content).toContain("studentPayments");
    expect(result.content).toContain("expenses");
  });

  it("a caller who isn't a member gets the same 'blocked' error getFinanceReports would", async () => {
    const result = await exportData({ userId: randomUUID(), branchIds: [], academyWide: false }, "finance_report", {}, "csv");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("blocked");
  });

  it("writes an audit row with action 'data.export' and entityType 'finance_report' on success", async () => {
    const { academyId, context, userId } = await setupAcademy("academy_owner");

    const result = await exportData(context, "finance_report", {}, "csv");
    expect(result.ok).toBe(true);

    const row = await latestExportAuditRow(academyId, "finance_report");
    expect(row).toBeDefined();
    expect(row.actorUserId).toBe(userId);
    expect(row.academyId).toBe(academyId);
    expect(row.result).toBe("success");
  });
});

// ---------------------------------------------------------------------
// student_report
// ---------------------------------------------------------------------

describe("exportData — student_report", () => {
  it("returns the exact same rows getStudentReports would", async () => {
    const { academyId, branchId, creatorUserId, context } = await setupAcademy("academy_owner");
    await insertStudentDirect(academyId, branchId, creatorUserId);
    await insertStudentDirect(academyId, branchId, creatorUserId);

    const direct = await getStudentReports(context);
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;
    const expectedRows = flattenStudentReport(direct.report);
    const expectedCsv = toCsv(expectedRows, [...STUDENT_REPORT_COLUMNS]);

    const result = await exportData(context, "student_report", {}, "csv");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rowCount).toBe(expectedRows.length);
    expect(result.content).toBe(expectedCsv);
  });

  it("never includes another academy's students in the export", async () => {
    const other = await setupAcademy("academy_owner");
    await insertStudentDirect(other.academyId, other.branchId, other.creatorUserId);

    const { context } = await setupAcademy("academy_owner");
    const result = await exportData(context, "student_report", {}, "csv");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only this academy's own single fixture student -> one "active" row of count 1.
    expect(result.content).toContain("statusBreakdown,active,active,1");
  });

  it("writes an audit row with entityType 'student_report' on success", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const result = await exportData(context, "student_report", {}, "csv");
    expect(result.ok).toBe(true);
    const row = await latestExportAuditRow(academyId, "student_report");
    expect(row).toBeDefined();
  });
});

// ---------------------------------------------------------------------
// academic_report
// ---------------------------------------------------------------------

describe("exportData — academic_report", () => {
  it("returns the exact same rows getAcademicReports would", async () => {
    const { academyId, branchId, creatorUserId, context } = await setupAcademy("academy_owner");
    const courseId = await insertProgramAndCourse(academyId);
    const batchId = await insertBatchDirect(academyId, branchId, courseId);
    const gradeConfigId = await insertGradeConfigDirect(academyId, creatorUserId);
    const examId = await insertExamDirect(academyId, batchId);
    const studentA = await insertStudentDirect(academyId, branchId, creatorUserId);
    const studentB = await insertStudentDirect(academyId, branchId, creatorUserId);
    await insertPublishedResultDirect(academyId, examId, studentA, batchId, gradeConfigId, creatorUserId, "pass", "A");
    await insertPublishedResultDirect(academyId, examId, studentB, batchId, gradeConfigId, creatorUserId, "fail", "F");

    const direct = await getAcademicReports(context);
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;
    const expectedRows = flattenAcademicReport(direct.report);
    const expectedCsv = toCsv(expectedRows, [...ACADEMIC_REPORT_COLUMNS]);

    const result = await exportData(context, "academic_report", {}, "csv");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rowCount).toBe(expectedRows.length);
    expect(result.content).toBe(expectedCsv);
    expect(result.content).toContain("passFailByBatch");
    expect(result.content).toContain("gradeDistribution");
  });

  it("a role with no exams/results access (admissions_officer) gets the same 'forbidden' error getAcademicReports would", async () => {
    const { context } = await setupAcademy("admissions_officer");
    const result = await exportData(context, "academic_report", {}, "csv");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("does not write an audit row when the export is forbidden", async () => {
    const { academyId, context } = await setupAcademy("admissions_officer");
    await exportData(context, "academic_report", {}, "csv");
    const row = await latestExportAuditRow(academyId, "academic_report");
    expect(row).toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// audit_log
// ---------------------------------------------------------------------

describe("exportData — audit_log", () => {
  it("returns the exact same rows getAcademyAuditLogs would", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    await insertAuditLogDirect(academyId, { action: "some.action" });
    await insertAuditLogDirect(academyId, { action: "some.other.action" });

    const direct = await getAcademyAuditLogs(context, {}, { page: 1, pageSize: 100 });
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;
    const expectedCsv = toCsv(direct.data.rows as unknown as Record<string, unknown>[], [...AUDIT_LOG_COLUMNS]);

    const result = await exportData(context, "audit_log", {}, "csv");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rowCount).toBe(direct.data.rows.length);
    expect(result.content).toBe(expectedCsv);
  });

  it("never includes another academy's audit log rows", async () => {
    const other = await setupAcademy("academy_owner");
    await insertAuditLogDirect(other.academyId, { action: "other-academy.action" });

    const { context } = await setupAcademy("academy_owner");
    const result = await exportData(context, "audit_log", {}, "csv");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).not.toContain("other-academy.action");
  });

  it("a role without academy.audit_log access (manager) gets the same 'forbidden' error getAcademyAuditLogs would", async () => {
    const { context } = await setupAcademy("manager");
    const result = await exportData(context, "audit_log", {}, "csv");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("writes an audit row with entityType 'audit_log' on success", async () => {
    const { academyId, context, userId } = await setupAcademy("academy_owner");
    await insertAuditLogDirect(academyId);

    const result = await exportData(context, "audit_log", {}, "csv");
    expect(result.ok).toBe(true);

    const row = await latestExportAuditRow(academyId, "audit_log");
    expect(row).toBeDefined();
    expect(row.actorUserId).toBe(userId);
    expect(row.action).toBe("data.export");
  });
});

// ---------------------------------------------------------------------
// student_list
// ---------------------------------------------------------------------

describe("exportData — student_list", () => {
  it("returns the exact same rows searchStudents would, containing exactly this academy's students", async () => {
    const { academyId, branchId, creatorUserId, context, studentId: fixtureStudentId } = await setupAcademy("academy_owner");
    const secondStudentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const direct = await searchStudents(context, {}, { page: 1, pageSize: 100 });
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;
    const expectedCsv = toCsv(direct.data.rows as unknown as Record<string, unknown>[], [...STUDENT_LIST_COLUMNS]);

    const result = await exportData(context, "student_list", {}, "csv");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rowCount).toBe(2);
    expect(result.content).toBe(expectedCsv);
    expect(result.content).toContain(fixtureStudentId);
    expect(result.content).toContain(secondStudentId);
  });

  it("an academy owner's export never includes another academy's students", async () => {
    const other = await setupAcademy("academy_owner");
    const otherStudentId = await insertStudentDirect(other.academyId, other.branchId, other.creatorUserId);

    const { context } = await setupAcademy("academy_owner");
    const result = await exportData(context, "student_list", {}, "csv");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).not.toContain(otherStudentId);
  });

  it("a caller who isn't a member gets the same 'blocked' error searchStudents would", async () => {
    const result = await exportData({ userId: randomUUID(), branchIds: [], academyWide: false }, "student_list", {}, "csv");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("blocked");
  });

  it("writes an audit row with entityType 'student_list' on success", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const result = await exportData(context, "student_list", {}, "csv");
    expect(result.ok).toBe(true);
    const row = await latestExportAuditRow(academyId, "student_list");
    expect(row).toBeDefined();
  });
});

// ---------------------------------------------------------------------
// format: json
// ---------------------------------------------------------------------

describe("exportData — json format", () => {
  it("serializes the same rows as pretty-printed JSON instead of CSV", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const result = await exportData(context, "student_report", {}, "json");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.format).toBe("json");
    expect(() => JSON.parse(result.content)).not.toThrow();
    expect(Array.isArray(JSON.parse(result.content))).toBe(true);
    void academyId;
  });
});
