import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { staffProfiles, users } from "@/lib/db/schema";
import { getAcademyShellData } from "@/lib/academies/shell";
import { getAcademyLogoUrl } from "@/lib/academies/academy-logo";
import { getVisibleAcademyNavItems, groupNavItems } from "@/lib/academies/nav-items";
import { ROLE_LABELS as ACADEMY_ROLE_LABELS } from "@/lib/academies/staff-labels";
import { getVisiblePlatformNavItems } from "@/lib/platform/nav-items";
import { hasPermission } from "@/lib/auth/permissions";
import { ACADEMY_STUDENTS_ACTION, getAcademyPermissionLevel } from "@/lib/auth/academy-permissions";
import { listNotificationsForUser } from "@/lib/notifications/list-notifications";
import { humanizeNotificationLabel } from "@/lib/notifications/humanize-template-id";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";

/**
 * Everything the shared console shell (app/_console/console-shell.tsx)
 * renders, resolved server-side so the client component never fetches data
 * or re-derives permissions. Navigation is filtered here from the same
 * permission tables every page enforces; the shell only draws what it gets.
 */

export interface ConsoleNavItem {
  key: string;
  label: string;
  href: string;
  icon: string;
  matchPrefixes?: string[];
}

export interface ConsoleNavGroup {
  title: string;
  items: ConsoleNavItem[];
}

export interface ConsoleNotificationPreview {
  id: string;
  label: string;
  /** ISO timestamp — serialized for the client component. */
  createdAt: string;
  unread: boolean;
}

export interface ConsoleShellData {
  console: "academy" | "platform";
  brand: { title: string; subtitle: string; logoUrl: string | null };
  groups: ConsoleNavGroup[];
  user: { name: string; email: string; roleLabel: string };
  notifications: { unreadCount: number; latest: ConsoleNotificationPreview[]; viewAllHref: string | null };
  /** Null when the account can't use any searchable list. */
  search: { placeholder: string; label: string } | null;
  /** Academy branch context (locked label for branch-limited roles). */
  contextLabel: string | null;
}

const NOTIFICATION_PREVIEW_LIMIT = 4;

function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

async function getEmail(userId: string): Promise<string> {
  const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.email ?? "";
}

/** The bell's preview: unread notifications first (newest first), then the
 * newest read ones to fill the remaining slots. Showing only the newest
 * overall hid older unread notifications (and their Mark as read) behind
 * newer read ones while the badge still counted them. */
async function getNotificationPreview(context: AuthContext) {
  const [unread, recent] = await Promise.all([
    listNotificationsForUser(context, { unreadOnly: true, limit: NOTIFICATION_PREVIEW_LIMIT }),
    listNotificationsForUser(context, { limit: NOTIFICATION_PREVIEW_LIMIT }),
  ]);
  const unreadIds = new Set(unread.map((item) => item.id));
  const latest = [...unread, ...recent.filter((item) => !unreadIds.has(item.id))].slice(0, NOTIFICATION_PREVIEW_LIMIT);
  return latest.map((item) => ({
    id: item.id,
    label: humanizeNotificationLabel(item.templateId),
    createdAt: item.createdAt.toISOString(),
    unread: item.readAt === null,
  }));
}

export async function getAcademyConsoleShellData(
  context: AuthContext,
  academyId: string,
  role: AcademyRole,
): Promise<ConsoleShellData> {
  const [shellData, email, profile, latest] = await Promise.all([
    getAcademyShellData(context, academyId, role),
    getEmail(context.userId),
    db
      .select({ fullName: staffProfiles.fullName })
      .from(staffProfiles)
      .where(and(eq(staffProfiles.academyId, academyId), eq(staffProfiles.userId, context.userId)))
      .limit(1),
    getNotificationPreview(context),
  ]);
  const logoUrl = await getAcademyLogoUrl(shellData.logoRef);

  return {
    console: "academy",
    brand: { title: shellData.academyName, subtitle: "Academy Console", logoUrl },
    groups: groupNavItems(getVisibleAcademyNavItems(role)).map((group) => ({
      title: group.title,
      items: group.items.map(({ key, label, href, icon, matchPrefixes }) => ({ key, label, href, icon, matchPrefixes })),
    })),
    user: { name: profile[0]?.fullName ?? nameFromEmail(email), email, roleLabel: ACADEMY_ROLE_LABELS[role] },
    notifications: {
      unreadCount: shellData.unreadNotificationsCount,
      latest,
      viewAllHref: "/academy/notifications",
    },
    search:
      getAcademyPermissionLevel(role, ACADEMY_STUDENTS_ACTION) !== "none"
        ? { placeholder: "Search students", label: "Search students by name or number" }
        : null,
    // Academy-wide roles see every branch, which says nothing new (the
    // dashboard carries its own working branch filter); branch-limited
    // roles see the branch(es) their data is locked to.
    contextLabel: shellData.branchChipLabel === "All branches" ? null : shellData.branchChipLabel,
  };
}

const PLATFORM_ROLE_LABELS = { platform_owner: "Platform Owner", platform_admin: "Platform Admin" } as const;

export async function getPlatformConsoleShellData(context: AuthContext): Promise<ConsoleShellData> {
  const [navItems, email, unread, latest, canSearchAcademies, canSearchPayments] = await Promise.all([
    getVisiblePlatformNavItems(context),
    getEmail(context.userId),
    listNotificationsForUser(context, { unreadOnly: true }),
    getNotificationPreview(context),
    hasPermission(context, "approveAcademy"),
    hasPermission(context, "recordSubscriptionPayment"),
  ]);

  const placeholder =
    canSearchAcademies && canSearchPayments
      ? "Search academies and payments"
      : canSearchAcademies
        ? "Search academies"
        : "Search payments";

  return {
    console: "platform",
    brand: { title: "Dardar", subtitle: "Platform Console", logoUrl: null },
    groups: groupNavItems(navItems).map((group) => ({
      title: group.title,
      items: group.items.map(({ key, label, href, icon }) => ({ key, label, href, icon })),
    })),
    user: {
      name: nameFromEmail(email),
      email,
      roleLabel: context.platformRole ? PLATFORM_ROLE_LABELS[context.platformRole] : "Platform staff",
    },
    // The shared account inbox (design S03 in the Platform shell).
    notifications: { unreadCount: unread.length, latest, viewAllHref: "/account/notifications" },
    search: canSearchAcademies || canSearchPayments ? { placeholder, label: placeholder } : null,
    contextLabel: null,
  };
}

export interface AccountIdentity {
  console: "academy" | "platform" | null;
  name: string;
  email: string;
  roleLabel: string | null;
  /** The phone on the caller's own academy staff record, if any. */
  phone: string | null;
}

/**
 * The signed-in user's own name, email, role and phone for the shared
 * account pages (S01). Same sources as the console shell's account menu:
 * the caller's staff record in their academy (name, phone), else a name
 * derived from the email; platform staff get their platform role. Reads
 * only the caller's own rows.
 */
export async function getAccountIdentity(
  context: AuthContext,
  academy: { academyId: string; role: AcademyRole } | null,
): Promise<AccountIdentity> {
  const email = await getEmail(context.userId);
  if (context.platformRole) {
    return { console: "platform", name: nameFromEmail(email), email, roleLabel: PLATFORM_ROLE_LABELS[context.platformRole], phone: null };
  }
  if (!academy) return { console: null, name: nameFromEmail(email), email, roleLabel: null, phone: null };
  const [profile] = await db
    .select({ fullName: staffProfiles.fullName, phone: staffProfiles.phone })
    .from(staffProfiles)
    .where(and(eq(staffProfiles.academyId, academy.academyId), eq(staffProfiles.userId, context.userId)))
    .limit(1);
  return {
    console: "academy",
    name: profile?.fullName ?? nameFromEmail(email),
    email,
    roleLabel: ACADEMY_ROLE_LABELS[academy.role],
    phone: profile?.phone ?? null,
  };
}
