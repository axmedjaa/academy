/**
 * PLAN.md Phase 5, Item 60 — `exportData`'s CSV serialization helper.
 *
 * Deliberately dependency-free (no `csv-stringify`/`papaparse`/etc.) per the
 * task brief: this file must not cause a new npm dependency, since a later,
 * unrelated step in this same wave needs sole access to `package.json`/
 * `package-lock.json`. `revenueBreakdownToCsv` (lib/subscriptions/reports.ts,
 * Item 32b) already established the "hand-rolled CSV, no library" precedent
 * for this codebase — this module generalizes that one-off helper into a
 * reusable one for every `exportData` entity type, with fuller RFC 4180
 * quoting (that earlier helper only ever serialized a plain group label, so
 * it never had to handle embedded newlines or `null`/`Date` values).
 *
 * ---------------------------------------------------------------------
 * Column selection
 * ---------------------------------------------------------------------
 * `columns`, when given, fixes both the column order and the exact field
 * set serialized: a key present on a row but absent from `columns` is
 * silently dropped, and a key in `columns` absent from a given row renders
 * as an empty cell. This is what lets a caller (i) still get a header row
 * for zero matching rows (`toCsv([], columns)` emits just the header line —
 * "the export is empty" should still look like a well-formed CSV, not a
 * blank file with no explanation of what columns would have appeared), and
 * (ii) mix rows of different "shapes" into one column superset on purpose
 * (e.g. the academic report flattener's per-batch pass/fail rows and its
 * per-grade-band rows share one CSV, each populating only the columns
 * relevant to that row). When `columns` is omitted, the header comes from
 * the first row's own `Object.keys()` — the plain case for a caller who
 * already has one consistent row shape (e.g. a raw entity table like
 * student records or audit log rows) and has nothing to serialize at all
 * when `rows` is empty (no columns to invent a header from).
 *
 * ---------------------------------------------------------------------
 * Value formatting
 * ---------------------------------------------------------------------
 * - `null`/`undefined` -> empty cell (never the literal text "null").
 * - `Date` -> `toISOString()`, the same convention every other
 *   Date-crossing-a-serialization-boundary case in this codebase already
 *   uses (e.g. app/academy/audit-logs/page.tsx's `row.createdAt.toISOString()`).
 * - A plain object/array (e.g. an audit log row's redacted `before`/`after`/
 *   `context` jsonb columns) -> `JSON.stringify(...)`, then quoted like any
 *   other field containing commas/quotes.
 * - Everything else -> `String(value)`.
 *
 * ---------------------------------------------------------------------
 * Quoting (RFC 4180)
 * ---------------------------------------------------------------------
 * A field is wrapped in double quotes if it contains a comma, a double
 * quote, or a line break (`\n` or `\r`); an embedded double quote is
 * doubled (`"` -> `""`). Rows are joined with `\n` (matching
 * `revenueBreakdownToCsv`'s existing convention, not `\r\n`) — every
 * consumer of this codebase's CSVs so far is a browser `Blob` download, not
 * a strict RFC 4180 parser that would care about the line-ending choice.
 */
export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  const cols = columns ?? (rows.length > 0 ? Object.keys(rows[0]) : []);
  if (cols.length === 0) return "";

  const lines = [cols.map(escapeCsvField).join(",")];
  for (const row of rows) {
    lines.push(cols.map((col) => escapeCsvField(formatCsvValue(row[col]))).join(","));
  }
  return lines.join("\n");
}

function formatCsvValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function escapeCsvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
