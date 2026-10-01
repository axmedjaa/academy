import { redirect } from "next/navigation";

/**
 * Navigation-audit Phase 1 — bare `/platform` previously 404'd (no
 * `page.tsx` existed at this segment; only `layout.tsx` + its subroutes).
 *
 * Phase 3 update: now redirects to `/platform/dashboard` (the new landing
 * page added that phase) instead of `/platform/academies` — matches the
 * updated `getPostLoginRedirectPath` (lib/auth/auth-context.ts) and the new
 * first item in `PLATFORM_NAV_ITEMS`.
 *
 * No auth check here: this route sits inside `app/platform/layout.tsx`,
 * which already resolves `getAuthContext()` and requires a platform role
 * before rendering any child route, including this one (a non-platform
 * user sees that layout's own "Access denied" message and never reaches
 * this redirect at all).
 */
export default function PlatformRootPage() {
  redirect("/platform/dashboard");
}
