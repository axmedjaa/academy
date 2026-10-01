import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { academies } from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { listAcademyTimetable, type TimetableActionError } from "@/lib/academies/timetables";
import { listBranches } from "@/lib/academies/branches";
import { listCourses } from "@/lib/academies/courses";
import { listBatches } from "@/lib/academies/batches";
import { listStaff } from "@/lib/academies/staff";
import { getAcademyLogoUrl } from "@/lib/academies/academy-logo";
import { buildTimetableGrid, filterTimetableEntries, type TimetableFilters, type TimetableGridSlot } from "@/lib/academies/timetable-grid";
import type { AuthContext } from "@/lib/auth/auth-context";

/**
 * Print data resolver for the weekly timetable — the same "new, additive
 * read layer over an existing, unmodified getter" shape as every other
 * `*-print.ts` file in this codebase (receipt-print.ts, book-sale-
 * receipt-print.ts). The ENTIRE authorization/tenant-isolation story is
 * inherited from the one call to `listAcademyTimetable` below — it already
 * resolves `academyId` from `actorContext` alone, already enforces
 * `ACADEMY_COURSES_BATCHES_ACTION`, and already filters to a branch-limited
 * caller's assigned branch(es). Every `filters.*Id` here only ever NARROWS
 * that already-scoped result (via `filterTimetableEntries`) — it is never
 * treated as authorization, and an id belonging to a different academy (or
 * simply not present in the caller's visible set) matches nothing, the same
 * generic empty-result behavior as any other mismatched id, never a
 * distinguishable error that would leak whether the id exists elsewhere.
 */
export interface TimetablePrintScope {
  branchName: string | null;
  courseName: string | null;
  batchName: string | null;
  instructorName: string | null;
}

export interface TimetablePrintData {
  academy: {
    name: string;
    logoUrl: string | null;
  };
  scope: TimetablePrintScope;
  /** Server-computed at fetch time — never `new Date()` inside the client
   * print view's render (SSR/hydration-mismatch risk), same convention as
   * book-sale-receipt-print.ts's `generatedAt`. */
  generatedAt: Date;
  slots: TimetableGridSlot[];
}

export type GetTimetablePrintDataResult =
  | { ok: true; data: TimetablePrintData }
  | { ok: false; error: TimetableActionError };

export async function getTimetablePrintData(
  actorContext: AuthContext,
  filters: TimetableFilters,
): Promise<GetTimetablePrintDataResult> {
  // The real authorization gate — everything below only narrows what this
  // already returned.
  const listResult = await listAcademyTimetable(actorContext);
  if (!listResult.ok) return listResult;

  const filtered = filterTimetableEntries(listResult.entries, filters);
  const slots = buildTimetableGrid(filtered);

  // Re-resolves academyId the same way listAcademyTimetable just did
  // internally (that function doesn't expose academyId itself) — needed so
  // the academy name/logo still renders even when the filtered result is
  // empty (an empty weekly timetable still needs a header).
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    // Unreachable in practice (listAcademyTimetable already succeeded
    // above, which requires the same non-blocked access) — defensive only.
    return { ok: false, error: { code: "blocked", message: access.message } };
  }

  const [academyRow] = await db
    .select({ name: academies.name, logoRef: academies.logoRef })
    .from(academies)
    .where(eq(academies.id, access.academyId))
    .limit(1);

  // Scope labels are resolved from the existing, already permission-scoped
  // list* getters (not from the filtered entries themselves) — a filter id
  // that currently has zero timetable rows (e.g. a brand-new batch) must
  // still show its real name in the printed header, not a blank line.
  const [branchesResult, coursesResult, batchesResult, staffResult] = await Promise.all([
    filters.branchId ? listBranches(actorContext) : null,
    filters.courseId ? listCourses(actorContext) : null,
    filters.batchId ? listBatches(actorContext) : null,
    filters.instructorId ? listStaff(actorContext) : null,
  ]);

  const branchName =
    filters.branchId && branchesResult?.ok
      ? (branchesResult.branches.find((b) => b.id === filters.branchId)?.name ?? null)
      : null;
  const courseName =
    filters.courseId && coursesResult?.ok
      ? (coursesResult.courses.find((c) => c.id === filters.courseId)?.name ?? null)
      : null;
  const batchName =
    filters.batchId && batchesResult?.ok
      ? (batchesResult.batches.find((b) => b.id === filters.batchId)?.name ?? null)
      : null;
  const instructorName =
    filters.instructorId && staffResult?.ok
      ? (staffResult.staff.find((s) => s.id === filters.instructorId)?.fullName ?? null)
      : null;

  return {
    ok: true,
    data: {
      academy: {
        name: academyRow?.name ?? "Academy",
        logoUrl: academyRow?.logoRef ? await getAcademyLogoUrl(academyRow.logoRef) : null,
      },
      scope: { branchName, courseName, batchName, instructorName },
      generatedAt: new Date(),
      slots,
    },
  };
}
