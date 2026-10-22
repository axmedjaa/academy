import { hasPermission } from "@/lib/auth/permissions";
import type { AuthContext } from "@/lib/auth/auth-context";

/**
 * Platform Owner console nav — mirrors lib/academies/nav-items.ts's shape
 * (key/label/href/icon/requiredCapability, filtered to exactly what the
 * signed-in actor can use), but for `/platform/*` rather than `/academy/*`.
 *
 * Unlike the academy nav (a pure, DB-free role->capability table lookup),
 * visibility here has to call the real `hasPermission()` — a platform_admin's
 * access is a per-user DB grant (`platform_admin_permissions`), not a static
 * role table, so filtering can't be pure/sync the way the academy nav is.
 * `getVisiblePlatformNavItems` is therefore async and takes the actor's
 * AuthContext directly, not a role enum.
 *
 * Every item's `requiredCapability` is the exact same string constant the
 * item's own page already gates on server-side (grepped from each
 * app/platform/**\/page.tsx before writing this) — this list only decides
 * whether a link is *shown*; it grants nothing by itself; the page (and, for
 * every mutation, the lib/*.ts action underneath it) re-checks
 * `hasPermission` independently regardless of what this file says.
 */
export interface PlatformNavItem {
  key: string;
  label: string;
  href: string;
  icon: string;
  /** Section heading in the sidebar (Platform Console "Main navigation"). */
  group: string;
  /** `null` = always visible to any signed-in platform actor (Dashboard),
   * mirroring lib/academies/nav-items.ts's `requiredAction: null`
   * convention. Non-null = only visible when `hasPermission(context,
   * requiredCapability)` resolves true. */
  requiredCapability: string | null;
}

// Order and grouping follow the active Platform Console design: Overview /
// Manage / Finance / Insights / Administration. Capabilities unchanged.
export const PLATFORM_NAV_ITEMS: readonly PlatformNavItem[] = [
  { key: "dashboard", label: "Dashboard", href: "/platform/dashboard", icon: "dashboard", group: "Overview", requiredCapability: null },
  { key: "academies", label: "Academies", href: "/platform/academies", icon: "apartment", group: "Manage", requiredCapability: "approveAcademy" },
  { key: "subscriptions", label: "Subscriptions", href: "/platform/subscriptions", icon: "autorenew", group: "Manage", requiredCapability: "renewSubscription" },
  { key: "plans", label: "Plans", href: "/platform/plans", icon: "receipt_long", group: "Manage", requiredCapability: "plans.manage" },
  { key: "payments", label: "Payments", href: "/platform/payments", icon: "payments", group: "Finance", requiredCapability: "recordSubscriptionPayment" },
  { key: "usage", label: "Usage", href: "/platform/usage", icon: "speed", group: "Insights", requiredCapability: "getPlatformReports" },
  { key: "reports", label: "Reports", href: "/platform/reports", icon: "bar_chart", group: "Insights", requiredCapability: "getPlatformReports" },
  { key: "audit-logs", label: "Audit log", href: "/platform/audit-logs", icon: "history", group: "Insights", requiredCapability: "queryAuditLogs" },
  { key: "staff", label: "Platform staff", href: "/platform/staff", icon: "group", group: "Administration", requiredCapability: "platform.staff.manage" },
  { key: "settings", label: "Settings", href: "/platform/settings", icon: "settings", group: "Administration", requiredCapability: "platform.settings.manage" },
] as const;

export async function getVisiblePlatformNavItems(
  context: AuthContext,
): Promise<PlatformNavItem[]> {
  const checks = await Promise.all(
    PLATFORM_NAV_ITEMS.map((item) =>
      item.requiredCapability === null ? Promise.resolve(true) : hasPermission(context, item.requiredCapability),
    ),
  );
  return PLATFORM_NAV_ITEMS.filter((_, index) => checks[index]);
}
