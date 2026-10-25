import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listExamResults } from "@/lib/academies/exams";
import { getBatch } from "@/lib/academies/batches";
import { listCourses } from "@/lib/academies/courses";
import { formatDate } from "@/lib/ui/date";
import { PAGE_WRAP, PageMessage } from "@/app/academy/_shell/ui";
import { MarksSheet } from "./marks-sheet";

/**
 * One exam's mark sheet (design A10 detail): back link, "Exam, BATCH ·
 * Course", out of / date, Save marks, and one row per student taking that
 * course in the batch. Reads go through listExamResults, which applies the
 * caller's scope (a Trainer sees only exams on batches they teach) and
 * returns not-found for anything else.
 */
export default async function ExamMarksPage({ params }: { params: Promise<{ examId: string }> }) {
  const { examId } = await params;
  const context = await getAuthContext();
  if (!context) redirect("/login");

  const result = await listExamResults(context, examId);
  if (!result.ok) {
    return (
      <PageMessage
        title={result.error.code === "blocked" ? "Access unavailable" : "Exam not available"}
        message={result.error.message}
      />
    );
  }

  const [batchResult, coursesResult] = await Promise.all([getBatch(context, result.exam.batchId), listCourses(context)]);
  const batchCode = batchResult.ok ? batchResult.batch.code : "Batch";
  const courseName =
    (coursesResult.ok ? coursesResult.courses.find((c) => c.id === result.exam.courseId)?.name : undefined) ?? "Course";

  return (
    <div className={PAGE_WRAP}>
      <MarksSheet
        exam={result.exam}
        title={`${result.exam.name}, ${batchCode} · ${courseName}`}
        description={`Out of ${result.exam.maxMarks} · ${formatDate(result.exam.examDate, "No date set")}`}
        rows={result.results.map((row) => ({
          resultId: row.id,
          studentId: row.studentId,
          name: row.studentFullName,
          number: row.studentNumber,
          marks: row.marksObtained,
          status: row.status,
          grade: row.gradeBandLabel,
          passFail: row.passFail,
        }))}
        canEnterMarks={result.canEnterMarks && result.exam.status !== "archived"}
      />
    </div>
  );
}
