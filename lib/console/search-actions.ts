"use server";

import { desc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { academies, subscriptionPayments } from "@/lib/db/schema";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasPermission } from "@/lib/auth/permissions";
import { searchStudents } from "@/lib/academies/students";
import { formatCalendarDate } from "@/lib/ui/date";

/**
 * Header search for the console shell (design: top-bar search with a
 * results dropdown). Every call re-resolves the session and re-checks the
 * same permission the destination list page enforces — the shell's own
 * decision to show the field is never trusted. Academy search delegates to
 * `searchStudents`, so tenant and branch scoping are exactly the Students
 * page's own.
 */
export interface ConsoleSearchResult {
  key: string;
  label: string;
  sub: string;
  href: string;
  icon: string;
}

const querySchema = z.string().trim().min(2).max(80);
const RESULT_LIMIT = 6;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export async function searchAcademyConsoleAction(rawQuery: string): Promise<ConsoleSearchResult[]> {
  const parsed = querySchema.safeParse(rawQuery);
  if (!parsed.success) return [];
  const context = await getAuthContext();
  if (!context) return [];

  const result = await searchStudents(context, { searchTerm: parsed.data }, { page: 1, pageSize: RESULT_LIMIT });
  if (!result.ok) return [];
  return result.data.rows.map((student) => ({
    key: student.id,
    label: student.fullName,
    sub: `Student · ${student.studentNumber}`,
    href: `/academy/students/${student.id}`,
    icon: "group",
  }));
}

export async function searchPlatformConsoleAction(rawQuery: string): Promise<ConsoleSearchResult[]> {
  const parsed = querySchema.safeParse(rawQuery);
  if (!parsed.success) return [];
  const context = await getAuthContext();
  if (!context?.platformRole) return [];

  const [canAcademies, canPayments] = await Promise.all([
    hasPermission(context, "approveAcademy"),
    hasPermission(context, "recordSubscriptionPayment"),
  ]);
  const pattern = `%${escapeLike(parsed.data)}%`;

  const [academyRows, paymentRows] = await Promise.all([
    canAcademies
      ? db
          .select({ id: academies.id, name: academies.name, slug: academies.slug })
          .from(academies)
          .where(ilike(academies.name, pattern))
          .orderBy(academies.name)
          .limit(RESULT_LIMIT)
      : Promise.resolve([]),
    canPayments
      ? db
          .select({
            id: subscriptionPayments.id,
            academyName: academies.name,
            amountCents: subscriptionPayments.amountCents,
            currency: subscriptionPayments.currency,
            status: subscriptionPayments.status,
            receivedAt: subscriptionPayments.receivedAt,
          })
          .from(subscriptionPayments)
          .innerJoin(academies, eq(academies.id, subscriptionPayments.academyId))
          // Same match as the Payments page's own search: academy name or payment id.
          .where(or(ilike(academies.name, pattern), ilike(sql`${subscriptionPayments.id}::text`, pattern)))
          .orderBy(desc(subscriptionPayments.receivedAt))
          .limit(4)
      : Promise.resolve([]),
  ]);

  return [
    ...academyRows.map((row) => ({
      key: `academy-${row.id}`,
      label: row.name,
      sub: `Academy · ${row.slug}`,
      href: `/platform/academies/${row.id}`,
      icon: "apartment",
    })),
    ...paymentRows.map((row) => ({
      key: `payment-${row.id}`,
      label: `${row.academyName} · ${(row.amountCents / 100).toFixed(2)} ${row.currency}`,
      sub: `Payment ${row.id.slice(0, 8).toUpperCase()} · ${row.status} · ${formatCalendarDate(row.receivedAt)}`,
      // Opens Payments filtered to this one payment (its search matches the id).
      href: `/platform/payments?q=${encodeURIComponent(row.id)}`,
      icon: "payments",
    })),
  ];
}
