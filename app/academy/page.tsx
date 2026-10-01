import { redirect } from "next/navigation";

/**
 * Navigation-audit Phase 1 — bare `/academy` previously 404'd (no
 * `page.tsx` existed at this segment; only `layout.tsx` + its subroutes).
 * Every academy member's real landing page is `/academy/dashboard` (also
 * the post-login redirect target for a non-platform user — see
 * `getPostLoginRedirectPath`, lib/auth/auth-context.ts), so a bookmarked
 * or manually-typed bare `/academy` now lands there instead of dead-ending.
 *
 * No auth check here: this route sits inside `app/academy/layout.tsx`,
 * which already resolves `getAuthContext()` + `checkAcademyAccessForContext`
 * before rendering any child route, including this one — redirecting
 * again here would only duplicate that same gate, not add a new one.
 */
export default function AcademyRootPage() {
  redirect("/academy/dashboard");
}
