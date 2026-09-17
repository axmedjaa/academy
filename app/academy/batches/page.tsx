import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listBatches } from "@/lib/academies/batches";
import { listBranches } from "@/lib/academies/branches";
import { listCourses } from "@/lib/academies/courses";
import { BatchesList } from "./batches-list";

/**
 * PLAN.md Item 43: `/academy/batches` — batch CRUD, the one entity in this
 * item that's branch-scoped (see lib/academies/batches.ts's module
 * comment). Same gating shape as app/academy/branches/page.tsx.
 */
export default async function AcademyBatchesPage() {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const result = await listBatches(context);

  if (!result.ok) {
    return (
      <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        <h1>{result.error.code === "blocked" ? "Access unavailable" : "Access denied"}</h1>
        <p>{result.error.message}</p>
      </main>
    );
  }

  // Best-effort: only used to populate the "Branch"/"Course" selects on the
  // create form — listBranches already applies the same branch-scoping for
  // branch-limited roles (Trainer), so a Trainer only ever sees their own
  // assigned branch(es) here too.
  const branchesResult = await listBranches(context);
  const branchOptions = branchesResult.ok ? branchesResult.branches : [];
  const coursesResult = await listCourses(context);
  const courseOptions = coursesResult.ok ? coursesResult.courses : [];

  return (
    <main
      style={{
        maxWidth: 900,
        margin: "2rem auto",
        fontFamily: "system-ui, sans-serif",
        padding: "0 1rem",
      }}
    >
      <h1>Batches</h1>
      <p style={{ color: "#666", fontSize: "0.9rem" }}>
        {result.canManage
          ? "You can create, edit, and archive batches in your scope."
          : "You can view the batch(es) in your scope."}
      </p>
      <BatchesList
        batches={result.batches}
        branches={branchOptions}
        courses={courseOptions}
        canManage={result.canManage}
      />
    </main>
  );
}
