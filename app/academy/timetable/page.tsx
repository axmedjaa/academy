import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listAcademyTimetable } from "@/lib/academies/timetables";
import { listBatches } from "@/lib/academies/batches";
import { listBranches } from "@/lib/academies/branches";
import { TimetableList } from "./timetable-list";

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
      <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        <h1>{result.error.code === "blocked" ? "Access unavailable" : "Access denied"}</h1>
        <p>{result.error.message}</p>
      </main>
    );
  }

  // Best-effort: populates the "Branch"/"Batch" selects on the create form —
  // both already apply the same branch-scoping for branch-limited roles.
  const branchesResult = await listBranches(context);
  const branchOptions = branchesResult.ok ? branchesResult.branches : [];
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
      <h1>Timetable</h1>
      <p style={{ color: "#666", fontSize: "0.9rem" }}>
        {result.canManage
          ? "You can create, edit, and delete timetable entries in your scope."
          : "You can view the timetable entries in your scope."}
      </p>
      <TimetableList
        entries={result.entries}
        branches={branchOptions}
        batches={batchOptions}
        canManage={result.canManage}
      />
    </main>
  );
}
