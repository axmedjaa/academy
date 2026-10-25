import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listGradeConfigurations } from "@/lib/academies/grade-configurations";
import { GradeConfigurationsList } from "./grade-configurations-list";
import { PAGE_WRAP, PageMessage } from "@/app/academy/_shell/ui";
import { listStaff } from "@/lib/academies/staff";
import { resolveStaffLabels } from "@/lib/academies/staff-labels";

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

  // "Created by": staff names for the creators (display only, from the
  // scoped staff list; anyone not on it shows as "Staff member").
  const staffResult = await listStaff(context);
  const creatorNames: Record<string, string> = Object.fromEntries(
    (staffResult.ok ? staffResult.staff : []).map((member) => [member.userId, member.fullName]),
  );
  // Creators without a staff profile (e.g. the academy owner) fall back to
  // their role in this academy, or their email, as payment history does.
  const missing = [...new Set(result.configurations.flatMap((c) => [c.createdBy, c.approvedBy ?? c.createdBy]))].filter((id) => !creatorNames[id]);
  if (missing.length > 0 && result.configurations[0]) {
    const labels = await resolveStaffLabels(result.configurations[0].academyId, missing);
    for (const id of missing) {
      const label = labels.get(id);
      if (label) creatorNames[id] = label;
    }
  }

  return (
    <div className={PAGE_WRAP}>
      <GradeConfigurationsList
        configurations={result.configurations}
        creatorNames={creatorNames}
        canManage={result.canManage}
        canApprove={result.canApprove}
      />
    </div>
  );
}
