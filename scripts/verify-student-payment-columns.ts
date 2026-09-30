/**
 * READ-ONLY verification — checks the Expected/Paid/Remaining/Status
 * relationship the Students list renders, for specific students by
 * studentNumber, straight from getStudentPaymentSummaries (the exact
 * function app/academy/students/page.tsx feeds into students-list.tsx).
 * No writes.
 */
import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { students } from "@/lib/db/schema";
import { getStudentPaymentSummaries } from "@/lib/academies/fee-periods";

const STUDENT_NUMBERS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["STD-000005", "STD-000006"];

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

async function main() {
  const rows = await db
    .select({ id: students.id, academyId: students.academyId, fullName: students.fullName, studentNumber: students.studentNumber })
    .from(students)
    .where(inArray(students.studentNumber, STUDENT_NUMBERS));

  if (rows.length === 0) {
    console.log(`No students found matching: ${STUDENT_NUMBERS.join(", ")}`);
    process.exit(0);
  }

  const byAcademy = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byAcademy.get(row.academyId) ?? [];
    list.push(row);
    byAcademy.set(row.academyId, list);
  }

  for (const [academyId, academyRows] of byAcademy) {
    const summaries = await getStudentPaymentSummaries(academyId, academyRows.map((r) => r.id));
    for (const row of academyRows) {
      const summary = summaries.get(row.id);
      console.log("=".repeat(80));
      console.log(`${row.fullName} (${row.studentNumber})  academy=${academyId}`);
      if (!summary) {
        console.log("  No payment summary (no active enrollment, or no fee schedule set).");
        continue;
      }
      const computedRemaining = Math.max(0, summary.expectedCents - summary.paidCents);
      console.log(`  Expected:  ${money(summary.expectedCents)}`);
      console.log(`  Paid:      ${money(summary.paidCents)}`);
      console.log(`  Remaining: ${money(summary.remainingCents)}  (Expected-Paid computed: ${money(computedRemaining)})`);
      console.log(`  Status:    ${summary.status}`);
      console.log(`  Relationship holds (remaining === max(0, expected-paid)): ${summary.remainingCents === computedRemaining}`);
    }
  }
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
