import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getTimetablePrintData } from "@/lib/academies/timetable-print";
import type { TimetableDay } from "@/lib/academies/timetable-constants";
import { DAYS_OF_WEEK } from "@/lib/academies/timetable-constants";
import { PageMessage } from "@/app/academy/_shell/ui";
import { TimetablePrintView } from "./timetable-print-view";

function isTimetableDay(value: string): value is TimetableDay {
  return (DAYS_OF_WEEK as readonly string[]).includes(value);
}

function paramOrUndefined(value: string | string[] | undefined): string | undefined {
  const single = Array.isArray(value) ? value[0] : value;
  return single && single.length > 0 ? single : undefined;
}

/**
 * `/academy/timetable/print` — the printable weekly timetable (approved
 * review §9/§D). Tenant isolation: `getTimetablePrintData` resolves
 * `academyId` from `actorContext` alone via the existing, unmodified
 * `listAcademyTimetable` — every `searchParams` value below is used ONLY to
 * narrow that already-scoped result (never as authorization), so a
 * branchId/courseId/batchId/instructorId belonging to a different academy,
 * or simply not visible to this caller, produces an empty (never an
 * error-revealing) result, same IDOR-safe convention as every other
 * `/academy/*` print route.
 */
export default async function TimetablePrintPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const context = await getAuthContext();
  if (!context) {
    redirect("/login");
  }

  const dayParam = paramOrUndefined(params.dayOfWeek);

  const result = await getTimetablePrintData(context, {
    branchId: paramOrUndefined(params.branchId),
    courseId: paramOrUndefined(params.courseId),
    batchId: paramOrUndefined(params.batchId),
    instructorId: paramOrUndefined(params.instructorId),
    dayOfWeek: dayParam && isTimetableDay(dayParam) ? dayParam : undefined,
  });

  if (!result.ok) {
    return (
      <PageMessage
        title={result.error.code === "blocked" ? "Access unavailable" : "Access denied"}
        message={result.error.message}
      />
    );
  }

  const autoprint = paramOrUndefined(params.autoprint);
  return <TimetablePrintView data={result.data} autoPrint={autoprint === "1"} />;
}
