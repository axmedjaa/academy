import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { academies } from "@/lib/db/schema";
import { getAuthContext } from "@/lib/auth/auth-context";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { checkIdCardAccess } from "@/lib/academies/id-cards";
import { IdCardLookup } from "./id-card-lookup";

/**
 * PLAN.md Item 40: `/academy/id-cards` — student ID card issue/reprint.
 *
 * Same gating shape as app/academy/branches/page.tsx (Item 34): the
 * `/academy/*` layout (Item 28) already ran a base subscription/membership
 * check, but has no channel to hand this page the resolved academyId/role,
 * so this page's own read (`checkIdCardAccess`) repeats a
 * `checkAcademyAccessForContext`-backed lookup itself (inside
 * lib/academies/id-cards.ts, not duplicated here).
 *
 * No student list/search is rendered here — Items 38/39 (student
 * registration, `/academy/students` search) own that UI and may not be
 * built yet (per this item's brief). Instead this page's client component
 * takes a student id directly (e.g. pasted from `/academy/students` once
 * that exists) and looks up/issues/reprints that one student's card.
 */
export default async function AcademyIdCardsPage() {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const result = await checkIdCardAccess(context);

  if (!result.ok) {
    return (
      <div>
        <h1>{result.error.code === "blocked" ? "Access unavailable" : "Access denied"}</h1>
        <p>{result.error.message}</p>
      </div>
    );
  }

  const access = await checkAcademyAccessForContext(context);
  const academyName =
    access.level === "blocked"
      ? "Academy"
      : ((await db.select({ name: academies.name }).from(academies).where(eq(academies.id, access.academyId)).limit(1))[0]
          ?.name ?? "Academy");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      <div>
        <h1 style={{ margin: 0 }}>Student ID cards</h1>
        <p style={{ margin: 0, marginTop: "0.25rem", color: "#6B7280" }}>
          {result.canManage
            ? "Look up a student by id to issue a new card or reprint their existing one."
            : "You don't have permission to issue or reprint student ID cards."}
        </p>
      </div>
      {result.canManage && <IdCardLookup academyName={academyName} />}
    </div>
  );
}
