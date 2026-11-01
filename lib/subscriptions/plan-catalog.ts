/**
 * The plan configuration vocabulary shared by the server (enforcement), the
 * Platform -> Plans editor and the public pricing cards. Pure and
 * database-free so client components can import it.
 *
 * This lists *which* limits and features exist and how to show them; every
 * plan's actual values (names, prices, limits, which features are on) live
 * in `subscription_plans` and are edited in Platform -> Plans. A feature is
 * only listed here once it has a server-side check (see
 * lib/subscriptions/entitlements.ts); core academy operations, certificates
 * and security features are on every plan and never appear here.
 */

export const PLAN_FEATURES = [
  {
    key: "sms",
    column: "smsEnabled",
    label: "SMS notifications",
    description: "Text messages for academy notifications.",
  },
  {
    key: "email",
    column: "emailEnabled",
    label: "Email notifications",
    description: "Email copies of academy notifications. Sign-in and security emails are always sent.",
  },
  {
    key: "advancedReports",
    column: "advancedReportsEnabled",
    label: "Advanced reports",
    description: "Finance and academic reports. The dashboard and student report are on every plan.",
  },
  {
    key: "exports",
    column: "exportsEnabled",
    label: "Data exports",
    description: "CSV exports of students, reports, finance records and the audit log.",
  },
] as const;

export type PlanFeature = (typeof PLAN_FEATURES)[number];
export type PlanFeatureKey = PlanFeature["key"];
export type PlanFeatureColumn = PlanFeature["column"];

export const PLAN_LIMITS = [
  { key: "maxBranches", resource: "branches", label: "Branches", unit: "count" },
  { key: "maxStudents", resource: "students", label: "Students", unit: "count" },
  { key: "maxStaff", resource: "staff", label: "Staff", unit: "count" },
  { key: "maxCourses", resource: "courses", label: "Courses", unit: "count" },
  { key: "maxStorageBytes", resource: "storage", label: "Storage", unit: "bytes" },
] as const;

export type PlanLimitKey = (typeof PLAN_LIMITS)[number]["key"];
export type PlanLimits = Record<PlanLimitKey, number | null>;

const GIB = 1024 ** 3;

/** Bytes as "2 GB" / "1.5 GB" / "750 MB". */
export function formatBytes(bytes: number): string {
  if (bytes >= GIB) {
    const gb = bytes / GIB;
    return `${Number.isInteger(gb) ? gb.toLocaleString("en-US") : gb.toFixed(1)} GB`;
  }
  const mb = bytes / 1024 ** 2;
  return `${Number.isInteger(mb) ? mb.toLocaleString("en-US") : mb.toFixed(1)} MB`;
}

/** A limit as shown to people: null is "Unlimited". */
export function formatLimit(unit: "count" | "bytes", value: number | null): string {
  if (value === null) return "Unlimited";
  return unit === "bytes" ? formatBytes(value) : value.toLocaleString("en-US");
}

export const BILLING_PERIOD_LABEL = { monthly: "month", quarterly: "quarter", annual: "year" } as const;
