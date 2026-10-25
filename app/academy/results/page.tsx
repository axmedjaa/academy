import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listResults } from "@/lib/academies/results";
import { listExams } from "@/lib/academies/exams";
import { listBatches } from "@/lib/academies/batches";
import { listCourses } from "@/lib/academies/courses";
import { listResultCorrections } from "@/lib/academies/result-corrections";
import { PAGE_WRAP, PageMessage } from "@/app/academy/_shell/ui";
import { ResultsList, type ResultsExam } from "./results-list";

/**
 * Results (design A12): marks by exam, reviewed, approved and published
 * here. Every read is scoped (a Trainer sees only results on batches they
 * teach); corrections are listed only for roles that may decide them.
 */
export default async function AcademyResultsPage() {
  const context = await getAuthContext();
  if (!context) redirect("/login");

  const result = await listResults(context);
  if (!result.ok) {
    return (
      <PageMessage
        title={result.error.code === "blocked" ? "Access unavailable" : "Access denied"}
        message={result.error.message}
      />
    );
  }

  const [examsResult, batchesResult, coursesResult, correctionsResult] = await Promise.all([
    listExams(context),
    listBatches(context),
    listCourses(context),
    listResultCorrections(context),
  ]);
  const batchCode = new Map((batchesResult.ok ? batchesResult.batches : []).map((b) => [b.id, b.code]));
  const courseName = new Map((coursesResult.ok ? coursesResult.courses : []).map((c) => [c.id, c.name]));
  const examIdsWithResults = new Set(result.results.map((row) => row.examId));
  const exams: ResultsExam[] = (examsResult.ok ? examsResult.exams : [])
    .filter((exam) => examIdsWithResults.has(exam.id))
    .map((exam) => ({
      id: exam.id,
      title: `${exam.name}, ${batchCode.get(exam.batchId) ?? "Batch"} · ${courseName.get(exam.courseId) ?? "Course"}`,
      maxMarks: exam.maxMarks,
      examDate: exam.examDate,
    }))
    .sort((a, b) => (b.examDate ?? "").localeCompare(a.examDate ?? ""));

  return (
    <div className={PAGE_WRAP}>
      <ResultsList
        exams={exams}
        results={result.results.map((row) => ({
          id: row.id,
          examId: row.examId,
          studentId: row.studentId,
          studentName: row.studentFullName,
          studentNumber: row.studentNumber,
          marks: row.marksObtained,
          status: row.status,
          grade: row.gradeBandLabel,
          passFail: row.passFail,
        }))}
        corrections={correctionsResult.ok ? correctionsResult.corrections : null}
        canSubmit={result.canSubmit}
        canApprove={result.canApprove}
      />
    </div>
  );
}
