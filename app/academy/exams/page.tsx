import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listExams } from "@/lib/academies/exams";
import { listBatches } from "@/lib/academies/batches";
import { ExamsList } from "./exams-list";

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
      <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        <h1>{result.error.code === "blocked" ? "Access unavailable" : "Access denied"}</h1>
        <p>{result.error.message}</p>
      </main>
    );
  }

  // Best-effort: populates the "Batch" select on the create form — already
  // applies the caller's own batch-scoping.
  const batchesResult = await listBatches(context);
  const batchOptions = batchesResult.ok ? batchesResult.batches : [];

  return (
    <main
      style={{
        maxWidth: 900,
        margin: "2rem auto",
        fontFamily: "system-ui, sans-serif",
        padding: "0 1rem",
      }}
    >
      <h1>Exams</h1>
      <p style={{ color: "#666", fontSize: "0.9rem" }}>
        {result.canManage
          ? "You can create exams and enter marks in your scope."
          : result.canEnterMarks
            ? "You can enter marks for exams on your assigned batches."
            : "You can view exams in your scope."}
      </p>
      <ExamsList
        exams={result.exams}
        batches={batchOptions}
        canManage={result.canManage}
        canEnterMarks={result.canEnterMarks}
      />
    </main>
  );
}
