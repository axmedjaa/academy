import type { AuthContext } from "@/lib/auth/auth-context";
import { listBatches } from "@/lib/academies/batches";
import { listBranches } from "@/lib/academies/branches";
import { listCourses } from "@/lib/academies/courses";

/**
 * What the shared "Enroll in courses" dialog offers: every planned or
 * active batch the caller can see, with the courses it runs. Built only
 * from the scoped list reads (listBatches applies tenant and branch scope),
 * so it never offers a batch the caller couldn't enroll into anyway — and
 * enrollStudentInBatch re-checks everything on submit.
 */
export interface EnrollBatchOption {
  id: string;
  code: string;
  name: string;
  branchId: string;
  branchName: string;
  status: "planned" | "active";
  startDate: string;
  courses: { id: string; name: string }[];
}

export async function getEnrollBatchOptions(
  context: AuthContext,
): Promise<{ canEnroll: boolean; batches: EnrollBatchOption[] }> {
  const [batchesResult, coursesResult, branchesResult] = await Promise.all([
    listBatches(context),
    listCourses(context),
    listBranches(context),
  ]);
  if (!batchesResult.ok) return { canEnroll: false, batches: [] };

  const courseName = new Map((coursesResult.ok ? coursesResult.courses : []).map((c) => [c.id, c.name]));
  const branchName = new Map((branchesResult.ok ? branchesResult.branches : []).map((b) => [b.id, b.name]));

  const batches = batchesResult.batches
    .filter((batch): batch is typeof batch & { status: "planned" | "active" } =>
      batch.status === "planned" || batch.status === "active",
    )
    .map((batch) => ({
      id: batch.id,
      code: batch.code,
      name: batch.name,
      branchId: batch.branchId,
      branchName: branchName.get(batch.branchId) ?? "Unknown branch",
      status: batch.status,
      startDate: batch.startDate,
      courses: batch.courseIds
        .filter((id) => courseName.has(id))
        .map((id) => ({ id, name: courseName.get(id) as string })),
    }))
    .filter((batch) => batch.courses.length > 0)
    .sort((a, b) => (a.status === b.status ? a.code.localeCompare(b.code) : a.status === "active" ? -1 : 1));

  return { canEnroll: batchesResult.canManage, batches };
}
