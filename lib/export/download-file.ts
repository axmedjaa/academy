/**
 * PLAN.md Phase 5, Item 60 — client-side file download for `exportData`'s
 * CSV/JSON output.
 *
 * Download mechanism choice: this codebase already has a working precedent
 * for "a server action returns file content, the client turns it into a
 * download" — `app/platform/reports/reports-manager.tsx`'s local
 * `downloadCsv` (Item 32b, `lib/subscriptions/reports.ts`'s own module
 * comment: "no new storage/file infrastructure... triggers a browser
 * download via a Blob URL"). Rather than a dedicated Route Handler (the
 * other valid Next.js 16 pattern for a downloadable file), this mirrors
 * that existing, already-working mechanism: a `Blob` + an in-memory
 * `<a download>` click, no new route, no server-side file storage. This
 * file generalizes it into one shared helper so every `exportData` caller
 * (four pages/components) doesn't reimplement the same dozen lines.
 */
export function downloadExportContent(
  content: string,
  filename: string,
  format: "csv" | "json",
): void {
  const mimeType = format === "json" ? "application/json;charset=utf-8;" : "text/csv;charset=utf-8;";
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
