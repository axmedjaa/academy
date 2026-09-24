"use client";

import { useState, useTransition } from "react";
import { recalculateUsageAction } from "@/lib/subscriptions/usage-actions";
import type { AcademyUsageOverviewRow } from "@/lib/subscriptions/usage";
import { Badge, Button, ErrorMessage, Section } from "@/app/academy/_shell/ui";

interface Props {
  rows: AcademyUsageOverviewRow[];
}

const RESOURCE_LABELS = {
  branches: "Branches",
  students: "Students",
  staff: "Staff",
  courses: "Courses",
  storage: "Storage",
} as const;

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

// DESIGN.md §3 "Usage/allowance bar": "Green under 80%, amber 80–99%, red
// at 100% (blocked)."
function barColorClass(percentage: number): string {
  if (percentage >= 100) return "bg-danger";
  if (percentage >= 80) return "bg-warning";
  return "bg-success";
}

function UsageBar({
  label,
  current,
  limit,
  formatValue,
}: {
  label: string;
  current: number;
  limit: number;
  formatValue?: (value: number) => string;
}) {
  const percentage = limit > 0 ? Math.min(100, (current / limit) * 100) : 0;
  const format = formatValue ?? ((value: number) => String(value));
  const overLimit = current >= limit;

  return (
    <div className="mb-2">
      <div className="mb-1 flex justify-between text-sm">
        <span className="text-ink">{label}</span>
        <span className={overLimit ? "font-medium text-danger" : "text-muted"}>
          {format(current)} / {format(limit)}
          {overLimit ? " — at limit" : ""}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-app">
        <div className={`h-full rounded-full ${barColorClass(percentage)}`} style={{ width: `${percentage}%` }} />
      </div>
    </div>
  );
}

export function UsageManager({ rows }: Props) {
  const [isPending, startTransition] = useTransition();
  const [pendingAcademyId, setPendingAcademyId] = useState<string | null>(null);
  const [errorsByAcademy, setErrorsByAcademy] = useState<Record<string, string>>({});

  function handleRecalculate(academyId: string) {
    setPendingAcademyId(academyId);
    setErrorsByAcademy((previous) => {
      const next = { ...previous };
      delete next[academyId];
      return next;
    });
    startTransition(async () => {
      const result = await recalculateUsageAction(academyId);
      if (!result.ok) {
        setErrorsByAcademy((previous) => ({
          ...previous,
          [academyId]: result.error.message,
        }));
      }
      setPendingAcademyId(null);
    });
  }

  if (rows.length === 0) {
    return (
      <Section>
        <p className="text-sm text-muted">No academies yet.</p>
      </Section>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {rows.map((row) => {
        const anyOverLimit =
          row.usage && row.limits
            ? row.usage.branchCount >= row.limits.maxBranches ||
              row.usage.activeStudentsCount >= row.limits.maxStudents ||
              row.usage.activeStaffCount >= row.limits.maxStaff ||
              row.usage.courseCount >= row.limits.maxCourses ||
              row.usage.storageUsedBytes >= row.limits.maxStorageBytes
            : false;

        return (
          <Section key={row.academyId} className={anyOverLimit ? "ring-1 ring-inset ring-danger/40" : ""}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <strong className="text-ink">{row.academyName}</strong>
                <span className="text-sm text-muted">{row.planName ?? "No active plan"}</span>
                {anyOverLimit && <Badge label="Over limit" tone="red" />}
              </div>
              <Button
                type="button"
                variant="secondary"
                className="px-2.5 py-1 text-xs"
                disabled={isPending && pendingAcademyId === row.academyId}
                onClick={() => handleRecalculate(row.academyId)}
              >
                {isPending && pendingAcademyId === row.academyId ? "Recalculating..." : "Recalculate"}
              </Button>
            </div>

            {errorsByAcademy[row.academyId] && (
              <div className="mb-3">
                <ErrorMessage message={errorsByAcademy[row.academyId]} />
              </div>
            )}

            {!row.limits && <p className="text-sm text-muted">No subscription/plan — allowance cannot be shown.</p>}

            {!row.usage && <p className="text-sm text-muted">Not yet calculated — click Recalculate.</p>}

            {row.usage && row.limits && (
              <>
                <UsageBar
                  label={RESOURCE_LABELS.branches}
                  current={row.usage.branchCount}
                  limit={row.limits.maxBranches}
                />
                <UsageBar
                  label={RESOURCE_LABELS.students}
                  current={row.usage.activeStudentsCount}
                  limit={row.limits.maxStudents}
                />
                <UsageBar
                  label={RESOURCE_LABELS.staff}
                  current={row.usage.activeStaffCount}
                  limit={row.limits.maxStaff}
                />
                <UsageBar
                  label={RESOURCE_LABELS.courses}
                  current={row.usage.courseCount}
                  limit={row.limits.maxCourses}
                />
                <UsageBar
                  label={RESOURCE_LABELS.storage}
                  current={row.usage.storageUsedBytes}
                  limit={row.limits.maxStorageBytes}
                  formatValue={formatBytes}
                />
                <p className="mt-2 text-xs text-muted">
                  {/* calculatedAt crosses the server->client boundary as a
                      serialized string despite its Date type (same as
                      payments-manager.tsx's receivedAt) — re-wrap before
                      formatting. */}
                  Last calculated {new Date(row.usage.calculatedAt).toLocaleString()}
                </p>
              </>
            )}
          </Section>
        );
      })}
    </div>
  );
}
