import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listResults } from "@/lib/academies/results";
import { ResultsList } from "./results-list";

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
      <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        <h1>{result.error.code === "blocked" ? "Access unavailable" : "Access denied"}</h1>
        <p>{result.error.message}</p>
      </main>
    );
  }

  return (
    <main
      style={{
        maxWidth: 1000,
        margin: "2rem auto",
        fontFamily: "system-ui, sans-serif",
        padding: "0 1rem",
      }}
    >
      <h1>Results</h1>
      <p style={{ color: "#666", fontSize: "0.9rem" }}>
        {result.canApprove
          ? "You can approve, reject, and publish submitted results."
          : result.canSubmit
            ? "You can submit marks-entered results for review."
            : "You can view results in your scope."}
      </p>
      <ResultsList results={result.results} canSubmit={result.canSubmit} canApprove={result.canApprove} />
    </main>
  );
}
