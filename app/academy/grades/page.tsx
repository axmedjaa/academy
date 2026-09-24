import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listGradeConfigurations } from "@/lib/academies/grade-configurations";
import { GradeConfigurationsList } from "./grade-configurations-list";
import { PAGE_WRAP, PageHeader, PageMessage } from "@/app/academy/_shell/ui";

/**
 * PLAN.md Item 47: `/academy/grades` — the grade-configuration approval
 * flow's UI (Draft -> Pending Approval -> Approved -> Active/Retired). Same
 * gating shape as app/academy/batches/page.tsx: resolve the trusted
 * AuthContext server-side, fetch through the already-gated
 * listGradeConfigurations, and render a calm access-denied state on
 * failure rather than a crash.
 *
 * No per-configuration band editor is built here beyond what Item 46
 * already ships (updateGradeBands) — the client component below submits
 * the same `bandsJson`-encoded hidden field grade-configurations-actions.ts
 * already expects, reusing Item 46's create/update actions as-is.
 */
export default async function AcademyGradesPage() {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const result = await listGradeConfigurations(context);

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
        title="Grade configurations"
        description={
          result.canApprove
            ? "You can create, submit, approve, reject, and activate grade configurations."
            : result.canManage
              ? "You can create, edit, submit, and activate grade configurations. Approving or rejecting a submission requires Manager or Owner authority."
              : "You don't have access to grade configurations for this academy."
        }
      />
      <GradeConfigurationsList
        configurations={result.configurations}
        canManage={result.canManage}
        canApprove={result.canApprove}
        currentUserId={context.userId}
      />
    </div>
  );
}
