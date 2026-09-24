import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getVisiblePlatformNavItems } from "@/lib/platform/nav-items";
import { PlatformShell } from "./_shell/platform-shell";
import { PageMessage } from "@/app/academy/_shell/ui";

const ROLE_LABELS = {
  platform_owner: "Platform Owner",
  platform_admin: "Platform Admin",
} as const;

/**
 * UI quality pass, Platform Owner console wave. Before this, every
 * `/platform/*` page rendered its own bare `<main>` with zero shared
 * navigation between the 9 platform tools — a real usability gap (a
 * platform_owner had to know each URL by heart), not just a styling one.
 *
 * This layout is purely additive presentation, mirroring
 * app/academy/layout.tsx's own shape: it does NOT replace any page's own
 * authorization check. Each `/platform/*` page still calls
 * `hasPermission(context, <its own capability>)` itself and still renders
 * its own "Access denied" when that fails — this layout only decides
 * whether to show the platform chrome at all (anyone with *some* platform
 * role) and which nav links to offer (best-effort convenience, matching
 * lib/academies/nav-items.ts's own "never shows a link the page itself
 * would refuse" — but the page's own check is always the real gate).
 *
 * A signed-in user with NO platform role at all (`context.platformRole` is
 * `undefined` — every academy-only user) gets a bare access-denied message,
 * not the shell — the same "don't wrap someone in navigation for a console
 * they have zero relationship to" reasoning app/academy/layout.tsx already
 * applies to a fully "blocked" academy visitor.
 */
export default async function PlatformLayout({ children }: LayoutProps<"/platform">) {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  if (!context.platformRole) {
    return (
      <PageMessage
        title="Access denied"
        message="You don't have permission to view the platform console."
      />
    );
  }

  const navItems = await getVisiblePlatformNavItems(context);

  return (
    <PlatformShell navItems={navItems} roleLabel={ROLE_LABELS[context.platformRole]}>
      {children}
    </PlatformShell>
  );
}
