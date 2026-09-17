import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listPrograms } from "@/lib/academies/programs";
import { ProgramsList } from "./programs-list";

/**
 * PLAN.md Item 43: `/academy/programs` — program CRUD. Same gating shape
 * as app/academy/branches/page.tsx: this page's own read (`listPrograms`)
 * repeats the `checkAcademyAccessForContext`-backed lookup itself (inside
 * lib/academies/programs.ts, not duplicated here).
 */
export default async function AcademyProgramsPage() {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const result = await listPrograms(context);

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
        maxWidth: 900,
        margin: "2rem auto",
        fontFamily: "system-ui, sans-serif",
        padding: "0 1rem",
      }}
    >
      <h1>Programs</h1>
      <p style={{ color: "#666", fontSize: "0.9rem" }}>
        {result.canManage
          ? "You can create, edit, and archive programs."
          : "You can view this academy's programs."}
      </p>
      <ProgramsList programs={result.programs} canManage={result.canManage} />
    </main>
  );
}
