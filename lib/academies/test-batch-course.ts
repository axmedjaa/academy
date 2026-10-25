import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { batchCourses, batches } from "@/lib/db/schema";

/**
 * Test-fixture helper only. Fixtures that insert `batches` rows directly
 * (bypassing createBatch) have no `batch_courses` row, which enrollments,
 * timetable entries and exams now reference through (batch_id, course_id).
 * Returns the batch's primary course and makes sure that pair exists.
 */
export async function courseOfBatch(batchId: string): Promise<string> {
  const [batch] = await db
    .select({ academyId: batches.academyId, courseId: batches.courseId })
    .from(batches)
    .where(eq(batches.id, batchId))
    .limit(1);
  if (!batch) throw new Error(`Fixture batch ${batchId} not found.`);
  await db
    .insert(batchCourses)
    .values({ academyId: batch.academyId, batchId, courseId: batch.courseId })
    .onConflictDoNothing({ target: [batchCourses.batchId, batchCourses.courseId] });
  return batch.courseId;
}
