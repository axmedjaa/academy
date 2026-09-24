import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listAcademyTimetable } from "@/lib/academies/timetables";
import { listBatches } from "@/lib/academies/batches";
import { listBranches } from "@/lib/academies/branches";
import { TimetableList } from "./timetable-list";
import { PAGE_WRAP, PageHeader, PageMessage } from "@/app/academy/_shell/ui";

/**
 * PLAN.md Item 45: `/academy/timetable` — academy-wide timetable CRUD, no
 * attendance fields anywhere (Decision #21). Same gating shape as
 * app/academy/batches/page.tsx.
 */
export default async function AcademyTimetablePage() {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const result = await listAcademyTimetable(context);

  if (!result.ok) {
    return (
      <PageMessage
        title={result.error.code === "blocked" ? "Access unavailable" : "Access denied"}
        message={result.error.message}
      />
    );
  }

  // Best-effort: populates the "Branch"/"Batch" selects on the create form —
  // both already apply the same branch-scoping for branch-limited roles.
  const branchesResult = await listBranches(context);
  const branchOptions = branchesResult.ok ? branchesResult.branches : [];
  const batchesResult = await listBatches(context);
  const batchOptions = batchesResult.ok ? batchesResult.batches : [];

  return (
    <div className={PAGE_WRAP}>
      <PageHeader
        title="Timetable"
        description={
          result.canManage
            ? "You can create, edit, and delete timetable entries in your scope."
            : "You can view the timetable entries in your scope."
        }
      />
      <TimetableList
        entries={result.entries}
        branches={branchOptions}
        batches={batchOptions}
        canManage={result.canManage}
      />
    </div>
  );
}
