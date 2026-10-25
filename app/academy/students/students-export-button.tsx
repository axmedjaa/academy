"use client";

import { useTransition } from "react";
import { exportStudentListAction } from "@/lib/export/export-data-actions";
import { downloadExportContent } from "@/lib/export/download-file";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";

/**
 * Students "Export CSV" (design A02 header action). Exports exactly the
 * filters currently on screen; the server re-checks access, applies the
 * caller's own scope, and records the export in the audit log.
 */
export function StudentsExportButton({
  filters,
}: {
  filters: {
    searchTerm?: string;
    branchId?: string;
    status?: "active" | "archived";
    batchId?: string;
    needsEnrollment?: boolean;
    payment?: "unpaid" | "overdue" | "paid";
  };
}) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await exportStudentListAction(filters, "csv");
          if (!result.ok) {
            showErrorToast(result.error.message);
            return;
          }
          downloadExportContent(result.content, result.filename, result.format);
          showSuccessToast("Export downloaded. It's recorded in the audit log.");
        })
      }
      className="inline-flex h-11 items-center rounded-lg border border-border-strong bg-surface px-4 font-semibold text-ink transition-colors duration-150 hover:bg-app disabled:opacity-60"
    >
      {pending ? "Exporting…" : "Export CSV"}
    </button>
  );
}
