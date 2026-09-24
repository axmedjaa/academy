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
  requiredCapability: string;
}

export const PLATFORM_NAV_ITEMS: readonly PlatformNavItem[] = [
  { key: "academies", label: "Academies", href: "/platform/academies", icon: "apartment", requiredCapability: "approveAcademy" },
  { key: "subscriptions", label: "Subscriptions", href: "/platform/subscriptions", icon: "autorenew", requiredCapability: "renewSubscription" },
  { key: "payments", label: "Payments", href: "/platform/payments", icon: "payments", requiredCapability: "recordSubscriptionPayment" },
  { key: "plans", label: "Plans", href: "/platform/plans", icon: "inventory_2", requiredCapability: "plans.manage" },
  { key: "usage", label: "Usage", href: "/platform/usage", icon: "speed", requiredCapability: "getPlatformReports" },
  { key: "reports", label: "Reports", href: "/platform/reports", icon: "bar_chart", requiredCapability: "getPlatformReports" },
  { key: "audit-logs", label: "Audit Log", href: "/platform/audit-logs", icon: "receipt_long", requiredCapability: "queryAuditLogs" },
  { key: "staff", label: "Platform Staff", href: "/platform/staff", icon: "badge", requiredCapability: "platform.staff.manage" },
  { key: "settings", label: "Settings", href: "/platform/settings", icon: "settings", requiredCapability: "platform.settings.manage" },
] as const;

export async function getVisiblePlatformNavItems(
  context: AuthContext,
): Promise<PlatformNavItem[]> {
  const checks = await Promise.all(
    PLATFORM_NAV_ITEMS.map((item) => hasPermission(context, item.requiredCapability)),
  );
  return PLATFORM_NAV_ITEMS.filter((_, index) => checks[index]);
}
