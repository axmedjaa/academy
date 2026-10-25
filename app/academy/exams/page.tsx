import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listExams } from "@/lib/academies/exams";
import { listBatches } from "@/lib/academies/batches";
import { listCourses } from "@/lib/academies/courses";
import { ExamsList } from "./exams-list";
import { PAGE_WRAP, PageMessage } from "@/app/academy/_shell/ui";

/**
 * PLAN.md Item 48: `/academy/exams` — minimal UI, logic+tests are this
 * item's priority (per its own brief). Same gating shape as
 * app/academy/timetable/page.tsx: a `blocked`/`forbidden` result renders a
 * plain message, otherwise the academy-wide (or, for a Trainer,
 * assigned-batch-scoped — see lib/academies/exams.ts's `listExams`) list of
 * exams plus a create form for managers/admins/owners and an "Enter marks"
 * panel for anyone who can enter marks.
 */
export default async function AcademyExamsPage() {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const result = await listExams(context);

  if (!result.ok) {
    return (
      <PageMessage
        title={result.error.code === "blocked" ? "Access unavailable" : "Access denied"}
        message={result.error.message}
      />
    );
  }

  // Best-effort: populates the "Batch" select on the create form — already
  // applies the caller's own batch-scoping.
  const batchesResult = await listBatches(context);
  const coursesResult = await listCourses(context);
  const courseNames = Object.fromEntries((coursesResult.ok ? coursesResult.courses : []).map((c) => [c.id, c.name]));

  // Batch options for Create exam (scoped by listBatches), each with its courses.
  const batchOptions = (batchesResult.ok ? batchesResult.batches : []).map((batch) => ({
    id: batch.id,
    code: batch.code,
    name: batch.name,
    status: batch.status,
    courses: batch.courseIds.map((id) => ({ id, name: courseNames[id] ?? "Unavailable course" })),
  }));

  return (
    <div className={PAGE_WRAP}>
      <ExamsList
        exams={result.exams}
        batches={batchOptions}
        courseNames={courseNames}
        canManage={result.canManage}
        canEnterMarks={result.canEnterMarks}
      />
    </div>
  );
}
