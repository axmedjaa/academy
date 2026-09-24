import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listPrograms } from "@/lib/academies/programs";
import { ProgramsList } from "./programs-list";
import { PAGE_WRAP, PageHeader, PageMessage } from "@/app/academy/_shell/ui";

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
      <PageMessage
        title={result.error.code === "blocked" ? "Access unavailable" : "Access denied"}
        message={result.error.message}
      />
    );
  }

  return (
    <div className={PAGE_WRAP}>
      <PageHeader
        title="Programs"
        description={
          result.canManage
            ? "You can create, edit, and archive programs."
            : "You can view this academy's programs."
        }
      />
      <ProgramsList programs={result.programs} canManage={result.canManage} />
    </div>
  );
}
