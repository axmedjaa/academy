import { getAuthContext } from "@/lib/auth/auth-context";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { PageMessage } from "@/app/academy/_shell/ui";

/**
 * Route guard for academy sections a Trainer must never see (admissions,
 * programs, courses, batches, branches, reports). A Trainer sees only their
 * assigned students, timetable, exams and results — see TRAINER_NAV_KEYS in
 * lib/academies/nav-items.ts. Used from each blocked section's layout.tsx,
 * so it also covers that section's detail pages. Every other role passes
 * straight through to the page's own permission checks.
 */
export async function TrainerBlocked({ children }: { children: React.ReactNode }) {
  const context = await getAuthContext();
  if (context) {
    const access = await checkAcademyAccessForContext(context);
    if (access.level !== "blocked" && access.membershipRole === "trainer") {
      return (
        <PageMessage
          title="Access denied"
          message="Trainers can see only their assigned students, timetable, exams and results."
        />
      );
    }
  }
  return <>{children}</>;
}
