import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getBatch } from "@/lib/academies/batches";
import {
  listBatchEnrollments,
  listBatchTrainerAssignments,
  listMyAssignedBatches,
} from "@/lib/academies/batch-assignments";
import { listStaff } from "@/lib/academies/staff";
import { searchStudents } from "@/lib/academies/students";
import { RosterPanel } from "./roster-panel";

/**
 * PLAN.md Phase 3, Item 44 — batch detail/roster view: assigned trainers +
 * enrolled students for one batch. Extends app/academy/batches/page.tsx's
 * list (Item 43) with a per-batch detail route rather than folding the
 * roster into the list page itself, per this item's own brief ("check
 * app/academy/batches/page.tsx's existing structure ... to decide whether
 * to extend it or add a new route").
 */
export default async function BatchRosterPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const { batchId } = await params;
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const batchResult = await getBatch(context, batchId);
  if (!batchResult.ok) {
    return (
      <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        <h1>{batchResult.error.code === "blocked" ? "Access unavailable" : "Access denied"}</h1>
        <p>{batchResult.error.message}</p>
      </main>
    );
  }

  const [assignmentsResult, enrollmentsResult, staffResult, studentsResult, myAssignedResult] =
    await Promise.all([
      listBatchTrainerAssignments(context, batchId),
      listBatchEnrollments(context, batchId),
      listStaff(context),
      searchStudents(context),
      listMyAssignedBatches(context),
    ]);

  const assignments = assignmentsResult.ok ? assignmentsResult.assignments : [];
  const enrollments = enrollmentsResult.ok ? enrollmentsResult.enrollments : [];
  const staffOptions = staffResult.ok ? staffResult.staff : [];
  const studentOptions = studentsResult.ok ? studentsResult.data.rows : [];
  const canManage = assignmentsResult.ok ? assignmentsResult.canManage : false;
  // "A Trainer viewing their batches" convenience — see
  // lib/academies/batch-assignments.ts's module comment on
  // getAssignedBatchIds/listMyAssignedBatches.
  const isAssignedToMe = myAssignedResult.ok && myAssignedResult.batchIds.includes(batchId);

  return (
    <main
      style={{
        maxWidth: 900,
        margin: "2rem auto",
        fontFamily: "system-ui, sans-serif",
        padding: "0 1rem",
      }}
    >
      <h1>
        {batchResult.batch.name} <small style={{ color: "#666" }}>({batchResult.batch.code})</small>
      </h1>
      <p style={{ color: "#666", fontSize: "0.9rem" }}>
        Status: {batchResult.batch.status}
        {isAssignedToMe && (
          <span style={{ marginLeft: "0.75rem", color: "#0a7", fontWeight: 600 }}>
            You are assigned to teach this batch
          </span>
        )}
      </p>
      <RosterPanel
        batchId={batchId}
        assignments={assignments}
        enrollments={enrollments}
        staffOptions={staffOptions.map((s) => ({ id: s.id, fullName: s.fullName }))}
        studentOptions={studentOptions.map((s) => ({ id: s.id, fullName: s.fullName, studentNumber: s.studentNumber }))}
        canManage={canManage}
      />
    </main>
  );
}
