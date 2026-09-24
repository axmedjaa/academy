import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listResults } from "@/lib/academies/results";
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
      <ResultsList results={result.results} canSubmit={result.canSubmit} canApprove={result.canApprove} />
    </div>
  );
}
