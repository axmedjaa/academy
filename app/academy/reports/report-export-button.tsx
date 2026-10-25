"use client";

import { useTransition } from "react";
import {
  exportAcademicReportAction,
  exportFinanceReportAction,
  exportStudentReportAction,
} from "@/lib/export/export-data-actions";
import { downloadExportContent } from "@/lib/export/download-file";
import { NETWORK_ERROR_MESSAGE } from "@/lib/ui/guard-action";
import { showErrorToast } from "@/lib/ui/toast";
import { Button } from "@/app/academy/_shell/ui";

/**
 * Export CSV for the open Reports tab. Sends the same filters the page is
 * showing (from the URL) to the matching audited export action, so the
 * file always matches what is on screen and every export is logged.
 */
export function ReportExportButton({
  kind,
  filters,
}: {
  kind: "student" | "academic" | "finance";
  filters: Record<string, string | undefined>;
}) {
  const [pending, startTransition] = useTransition();

  function handleExport() {
    startTransition(async () => {
      try {
        const action =
          kind === "student" ? exportStudentReportAction : kind === "academic" ? exportAcademicReportAction : exportFinanceReportAction;
        const result = await action(filters, "csv");
        if (!result.ok) {
          showErrorToast(result.error.message);
          return;
        }
        downloadExportContent(result.content, result.filename, result.format);
      } catch {
        showErrorToast(NETWORK_ERROR_MESSAGE);
      }
    });
  }

  return (
    <Button type="button" variant="secondary" onClick={handleExport} disabled={pending}>
      {pending ? "Exporting…" : "Export CSV"}
    </Button>
  );
}
