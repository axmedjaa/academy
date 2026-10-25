import type { AcademyRole } from "@/lib/auth/roles";

/** Display names for academy roles. Pure (no DB), so both server helpers and
 * client components can import it. */
export const ACADEMY_ROLE_LABELS: Record<AcademyRole, string> = {
  academy_owner: "Academy Owner",
  academy_admin: "Academy Administrator",
  manager: "Manager",
  admissions_officer: "Admissions Officer",
  finance_officer: "Finance Officer",
  trainer: "Trainer",
};
