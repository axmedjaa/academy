import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { AcademyAccessMessage } from "./academy-access-message";

/**
 * PLAN.md Item 28 — "Minimal `/academy/dashboard` shell." This is the
 * first route under `/academy/*`, so there's a real choice between gating
 * inline on the one page (matching app/protected/page.tsx and
 * app/platform/staff/page.tsx's pattern) or gating once here in a shared
 * layout. Going with a layout, for two reasons:
 *
 * 1. lib/academies/access-gate.ts's own Item 27 header comment names
 *    "a future `/academy/*` layout or page (Item 28+)" as its intended
 *    caller — a layout is the anticipated shape.
 * 2. Unlike the /platform/* pages (each of which checks a *different*
 *    hasPermission() capability, so a shared layout there wouldn't fit),
 *    every /academy/* page needs the exact same subscription/membership
 *    check. PLAN.md's Phase 2 (Items 33-42) adds many more /academy/*
 *    pages (branches, staff, students, settings, audit log, ...); gating
 *    once here means none of them has to repeat the
 *    getAuthContext()+checkAcademyAccessForContext()+redirect/blocked-
 *    render dance individually.
 *
 * Tradeoff worth flagging: Next.js layouts have no built-in channel for
 * passing arbitrary data (like the resolved academyId/membershipRole) down
 * to child pages — only `children` and route params. This layout's
 * checkAcademyAccessForContext() call is used only to decide
 * redirect/block/grace-banner/render-children here; a future page that
 * needs academyId or membershipRole for its own queries will have to
 * resolve that itself (e.g. its own DB lookup, or a fresh
 * checkAcademyAccess call). That's an extra round trip when it happens,
 * but no current /academy/* page (this dashboard shell has no real
 * content yet) needs it, so it's left as a note rather than solved here
 * (e.g. via a request-scoped React `cache()` wrapper) to avoid touching
 * access-gate.ts, which is out of scope for this item.
 */
export default async function AcademyLayout({ children }: LayoutProps<"/academy">) {
  const authContext = await getAuthContext();

  if (!authContext) {
    redirect("/login");
  }

  const access = await checkAcademyAccessForContext(authContext);

  if (access.level === "blocked") {
    if (access.reason === "not_authenticated") {
      // Defensive/unreachable: the null-context check above already
      // redirects before this call, but the return type includes this
      // reason, so it's handled rather than assumed away.
      redirect("/login");
    }
    return <AcademyAccessMessage reason={access.reason} message={access.message} />;
  }

  // "grace" (Past Due, within the 7-day window) renders full content plus
  // a persistent, non-dismissible banner — DESIGN.md §11.1: "Full, with a
  // persistent banner" / *"Past Due — 5 days remaining in grace period."*
  return (
    <>
      {access.level === "grace" && access.message ? (
        <div
          role="status"
          style={{
            backgroundColor: "#FEF3C7",
            color: "#92400E",
            borderBottom: "1px solid #F3D98B",
            padding: "0.75rem 1.5rem",
            fontFamily: "system-ui, sans-serif",
            fontSize: "0.9rem",
          }}
        >
          {access.message}
        </div>
      ) : null}
      {children}
    </>
  );
}
