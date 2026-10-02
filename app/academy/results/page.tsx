import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listResults } from "@/lib/academies/results";
import { listExams } from "@/lib/academies/exams";
import { getStudentPhotoUrlsByIds } from "@/lib/academies/students";
import { ResultsList } from "./results-list";
import { PAGE_WRAP, PageHeader, PageMessage } from "@/app/academy/_shell/ui";

/**
 * PLAN.md Item 49: `/academy/results` — minimal UI, logic+tests are this
 * item's priority (same "No Docker anywhere ... minimal UI" bar Item 48's
 * `/academy/exams` page set). Same gating shape as that page: a
 * `blocked`/`forbidden` result renders a plain message, otherwise the
 * academy-wide (or, for a Trainer, assigned-batch-scoped) list of exam
 * results with Submit/Approve/Reject/Publish controls, each shown only to
 * an actor whose permission level actually reaches that action.
 */
export default async function AcademyResultsPage() {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const result = await listResults(context);

  if (!result.ok) {
    return (
      <PageMessage
        title={result.error.code === "blocked" ? "Access unavailable" : "Access denied"}
        message={result.error.message}
      />
    );
  }

  // Display-only exam-name resolution — `listExams` is the exact same
  // already-gated, already-scoped read app/academy/exams/page.tsx itself
  // calls; every examId being resolved here already came from `listResults`
  // (itself tenant/scope-checked), so this is a label lookup on
  // already-authorized ids, not a fresh authorization decision (same
  // reasoning as lib/academies/id-cards-actions.ts's own resolveStudentName
  // comment). Previously the page had no name at all here — the "Exam
  // {examId}" section heading below showed the raw database id.
  const examsResult = await listExams(context);
  const examNames = Object.fromEntries((examsResult.ok ? examsResult.exams : []).map((exam) => [exam.id, exam.name]));

  // Same server-side signed-URL resolution as the other student-identity
  // pages — a real photo only ever reaches the browser as a short-lived
  // signed GET, never the raw profileImageRef object key. ResultRosterRow
  // carries studentId but not profileImageRef, so this uses the batch
  // variant rather than resolving one `StudentRecord` per row.
  const photoUrlByStudentId = await getStudentPhotoUrlsByIds(context, result.results.map((row) => row.studentId));

  return (
    <div className={PAGE_WRAP}>
      <PageHeader
        title="Results"
        description={
          result.canApprove
            ? "You can approve, reject, and publish submitted results."
            : result.canSubmit
              ? "You can submit marks-entered results for review."
              : "You can view results in your scope."
        }
      />
      <ResultsList
        results={result.results}
        examNames={examNames}
        photoUrlByStudentId={photoUrlByStudentId}
        canSubmit={result.canSubmit}
        canApprove={result.canApprove}
      />
    </div>
  );
}
