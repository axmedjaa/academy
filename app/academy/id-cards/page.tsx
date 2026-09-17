import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
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
      <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        <h1>{result.error.code === "blocked" ? "Access unavailable" : "Access denied"}</h1>
        <p>{result.error.message}</p>
      </main>
    );
  }

  return (
    <main
      style={{
        maxWidth: 700,
        margin: "2rem auto",
        fontFamily: "system-ui, sans-serif",
        padding: "0 1rem",
      }}
    >
      <h1>Student ID cards</h1>
      <p style={{ color: "#666", fontSize: "0.9rem" }}>
        {result.canManage
          ? "Look up a student by id to issue a new card or reprint their existing one."
          : "You don't have permission to issue or reprint student ID cards."}
      </p>
      {result.canManage && <IdCardLookup />}
    </main>
  );
}
