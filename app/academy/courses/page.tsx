import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listCourses } from "@/lib/academies/courses";
import { listPrograms } from "@/lib/academies/programs";
import { CoursesList } from "./courses-list";

/**
 * PLAN.md Item 43: `/academy/courses` — course CRUD, `checkAllowance('courses')`
 * enforced server-side inside `createCourse`. Same gating shape as
 * app/academy/branches/page.tsx.
 */
export default async function AcademyCoursesPage() {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const result = await listCourses(context);

  if (!result.ok) {
    return (
      <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        <h1>{result.error.code === "blocked" ? "Access unavailable" : "Access denied"}</h1>
        <p>{result.error.message}</p>
      </main>
    );
  }

  // Best-effort: only used to populate the "Program" select on the create
  // form. If the caller can't list programs for some reason, the form
  // simply renders with no options rather than failing the whole page.
  const programsResult = await listPrograms(context);
  const programs = programsResult.ok ? programsResult.programs : [];

  return (
    <main
      style={{
        maxWidth: 900,
        margin: "2rem auto",
        fontFamily: "system-ui, sans-serif",
        padding: "0 1rem",
      }}
    >
      <h1>Courses</h1>
      <p style={{ color: "#666", fontSize: "0.9rem" }}>
        {result.canManage
          ? "You can create, edit, and archive courses."
          : "You can view this academy's courses."}
      </p>
      <CoursesList courses={result.courses} programs={programs} canManage={result.canManage} />
    </main>
  );
}
