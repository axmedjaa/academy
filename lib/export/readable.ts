import { ACADEMY_ROLE_LABELS } from "@/lib/auth/role-labels";
import type { AcademyRole } from "@/lib/auth/roles";
import { formatMoney } from "@/lib/ui/money";

/**
 * Human-readable values for exported files (CSV/JSON). Pure and
 * dependency-free, so it is safe anywhere and easy to test.
 *
 * Exports are read by academy administrators, managers and accountants in
 * a spreadsheet, so every exported value is the one they see in the app:
 * names instead of internal ids, "Nov 5, 2026" instead of an ISO
 * timestamp, "$1,250.00" instead of cents, "Partially Paid" instead of
 * `partially_paid`. Internal ids stay in the database and application
 * logic; they are only kept out of the files people download.
 */

/** Dates and times in exports use the academy region's time zone, the same
 * one the on-screen audit log uses. */
export const EXPORT_TIME_ZONE = "Africa/Mogadishu";

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: EXPORT_TIME_ZONE });
const DATE_TIME = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: EXPORT_TIME_ZONE,
});
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-05" (calendar date) or a timestamp -> "Nov 5, 2026". */
export function exportDate(value: Date | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    // A calendar date has no time zone: never shift it a day.
    if (m) return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : DATE.format(date);
}

/** A timestamp -> "Nov 5, 2026, 13:30". */
export function exportDateTime(value: Date | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : DATE_TIME.format(date);
}

/** "2026-10" -> "Oct 2026". Anything else is returned unchanged. */
export function exportMonth(value: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(value);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : value;
}

/** Cents -> "$1,250.00" in that currency (the same format as the app). */
export function exportMoney(amountCents: number | null | undefined, currency: string | null | undefined): string {
  if (amountCents === null || amountCents === undefined) return "";
  return formatMoney(amountCents, currency || "USD");
}

/** 0.875 -> "87.5%". */
export function exportPercent(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || Number.isNaN(fraction)) return "";
  return `${Math.round(fraction * 1000) / 10}%`;
}

/** Status words that read better than a mechanical conversion. */
const STATUS_LABELS: Record<string, string> = {
  partially_paid: "Partially Paid",
  paid: "Paid",
  fully_paid: "Fully Paid",
  unpaid: "Unpaid",
  pending_verification: "Awaiting Verification",
  pending: "Pending",
  success: "Success",
  failure: "Failed",
  active: "Active",
  inactive: "Inactive",
  archived: "Archived",
  removed: "Removed",
  mobile_money: "Mobile Money",
  bank_transfer: "Bank Transfer",
  cash: "Cash",
  other_person: "Other Person",
  student: "Student",
};

/** A raw code value -> words: `partially_paid` -> "Partially Paid",
 * `enrollStudentInBatch` -> "Enroll Student In Batch". */
export function exportLabel(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const known = STATUS_LABELS[value];
  if (known) return known;
  const words = value
    .replace(/[._-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") || value;
}

/** An action code as the audit log screen shows it: sentence case
 * ("enrollStudentInBatch" -> "Enroll student in batch"). */
export function exportAction(action: string): string {
  const words = action
    .replace(/[._-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : action;
}

const PLATFORM_ROLE_LABELS: Record<string, string> = {
  platform_owner: "Platform Owner",
  platform_admin: "Platform Administrator",
};

/** Academy or platform role code -> its display name. */
export function exportRole(role: string | null | undefined): string {
  if (!role) return "";
  return ACADEMY_ROLE_LABELS[role as AcademyRole] ?? PLATFORM_ROLE_LABELS[role] ?? exportLabel(role);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a value that is an internal database identifier. */
export function isInternalId(value: unknown): boolean {
  return typeof value === "string" && UUID.test(value);
}

/** Keys of stored snapshots that are internal references or secrets, never
 * shown in a business export. */
const HIDDEN_KEY = /(^id$|Id$|Ids$|_id$|Ref$|_ref$|hash|password|token|secret|^ip$|userAgent)/i;

/** Keys that name the record a snapshot describes, best first. */
const RECORD_NAME_KEYS = ["fullName", "name", "reference", "title", "studentNumber", "receiptNumber", "certificateCode", "code", "email"];

/** A readable name for the record an audit row describes, from its stored
 * snapshot ("Ayaan Hassan", "PO-2026-0007"), or "" when it has none. */
export function recordNameFrom(...snapshots: unknown[]): string {
  for (const snap of snapshots) {
    if (!snap || typeof snap !== "object" || Array.isArray(snap)) continue;
    const obj = snap as Record<string, unknown>;
    for (const key of RECORD_NAME_KEYS) {
      const v = obj[key];
      if (typeof v === "string" && v.trim() && !isInternalId(v)) return v.trim();
    }
  }
  return "";
}

function fieldLabel(key: string): string {
  return exportLabel(key.replace(/Cents$/, ""));
}

function snapshotValue(key: string, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return "—";
  if (isInternalId(value)) return null;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  // A snapshot records cents without its currency: show the plain amount.
  if (typeof value === "number") return /Cents$/.test(key) ? (value / 100).toFixed(2) : String(value);
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return exportDateTime(value);
    // Codes ("partially_paid") and status-like fields ("active") read as words.
    if (/^[a-z]+(_[a-z]+)+$/.test(value) || (/(status|method|type|result|role)$/i.test(key) && /^[a-z_]+$/.test(value))) {
      return /role$/i.test(key) ? exportRole(value) : exportLabel(value);
    }
    return value;
  }
  // Nested structures are summarized, not dumped.
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  return null;
}

/**
 * A stored before/after snapshot pair -> readable changes:
 * "Status: Active → Archived; Phone: +252 61 … → +252 63 …". Internal ids,
 * references and secrets are left out; nested data is summarized. A create
 * (no `before`) lists the recorded values; a removal lists what was removed.
 */
export function describeChanges(before: unknown, after: unknown, maxLength = 1000): string {
  const b = before && typeof before === "object" && !Array.isArray(before) ? (before as Record<string, unknown>) : null;
  const a = after && typeof after === "object" && !Array.isArray(after) ? (after as Record<string, unknown>) : null;
  if (!b && !a) return "";
  const keys = Array.from(new Set([...Object.keys(b ?? {}), ...Object.keys(a ?? {})])).filter((k) => !HIDDEN_KEY.test(k));
  const parts: string[] = [];
  for (const key of keys) {
    const bv = b ? snapshotValue(key, b[key]) : null;
    const av = a ? snapshotValue(key, a[key]) : null;
    if (b && a) {
      if (key in b && key in a && JSON.stringify(b[key]) === JSON.stringify(a[key])) continue;
      if (bv === null && av === null) continue;
      parts.push(`${fieldLabel(key)}: ${bv ?? "—"} → ${av ?? "—"}`);
    } else {
      const v = av ?? bv;
      if (v === null || v === "—") continue;
      parts.push(`${fieldLabel(key)}: ${v}`);
    }
  }
  const text = parts.join("; ");
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
