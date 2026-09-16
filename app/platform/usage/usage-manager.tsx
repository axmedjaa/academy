"use client";

import { useState, useTransition } from "react";
import { recalculateUsageAction } from "@/lib/subscriptions/usage-actions";
import type { AcademyUsageOverviewRow } from "@/lib/subscriptions/usage";

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
function barColor(percentage: number): string {
  if (percentage >= 100) return "#c0392b";
  if (percentage >= 80) return "#d68910";
  return "#2e8b57";
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
    <div style={{ marginBottom: "0.5rem" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: "0.85rem",
          marginBottom: "0.15rem",
        }}
      >
        <span>{label}</span>
        <span style={{ color: overLimit ? "#c0392b" : "#333" }}>
          {format(current)} / {format(limit)}
          {overLimit ? " — at limit" : ""}
        </span>
      </div>
      <div
        style={{
          background: "#eee",
          borderRadius: 4,
          height: 8,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${percentage}%`,
            background: barColor(percentage),
            height: "100%",
          }}
        />
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
    return <p>No academies yet.</p>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
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
          <section
            key={row.academyId}
            style={{
              border: `1px solid ${anyOverLimit ? "#c0392b" : "#ddd"}`,
              borderRadius: 8,
              padding: "1rem 1.25rem",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                marginBottom: "0.75rem",
              }}
            >
              <div>
                <strong>{row.academyName}</strong>
                <span style={{ color: "#666", marginLeft: "0.5rem" }}>
                  {row.planName ?? "No active plan"}
                </span>
              </div>
              <button
                type="button"
                disabled={isPending && pendingAcademyId === row.academyId}
                onClick={() => handleRecalculate(row.academyId)}
              >
                {isPending && pendingAcademyId === row.academyId
                  ? "Recalculating..."
                  : "Recalculate"}
              </button>
            </div>

            {errorsByAcademy[row.academyId] && (
              <p style={{ color: "#c0392b", fontSize: "0.85rem" }}>
                {errorsByAcademy[row.academyId]}
              </p>
            )}

            {!row.limits && (
              <p style={{ color: "#666", fontSize: "0.85rem" }}>
                No subscription/plan — allowance cannot be shown.
              </p>
            )}

            {!row.usage && (
              <p style={{ color: "#666", fontSize: "0.85rem" }}>
                Not yet calculated — click Recalculate.
              </p>
            )}

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
                <p style={{ color: "#888", fontSize: "0.75rem", marginTop: "0.5rem" }}>
                  {/* calculatedAt crosses the server->client boundary as a
                      serialized string despite its Date type (same as
                      payments-manager.tsx's receivedAt) — re-wrap before
                      formatting. */}
                  Last calculated {new Date(row.usage.calculatedAt).toLocaleString()}
                </p>
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}
