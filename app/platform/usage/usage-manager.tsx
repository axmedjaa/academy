"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { recalculateUsageAction } from "@/lib/subscriptions/usage-actions";
import type { AcademyUsageOverviewRow } from "@/lib/subscriptions/usage";
import { NETWORK_ERROR_MESSAGE } from "@/lib/ui/guard-action";
import { formatDate } from "@/lib/ui/date";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";
import { Badge, EmptyState, ErrorMessage, Section } from "@/app/academy/_shell/ui";
import { Icon } from "@/app/academy/_shell/icons";
import { ROW_BTN } from "@/app/academy/_shell/page-blocks";
import { UsageBar, formatGb } from "../_shared/usage-bar";
import { planLabel } from "../_shared/status";

/**
 * Usage (design P08): one card per academy with five allowance bars from
 * the last usage snapshot, an "Over limit" badge and red ring when any
 * resource is at or over its limit, and Recalculate. Display only;
 * allowances are enforced live when records are created, never here.
 */
export function UsageManager({ rows }: { rows: AcademyUsageOverviewRow[] }) {
  const [isPending, startTransition] = useTransition();
  const [pendingAcademyId, setPendingAcademyId] = useState<string | null>(null);
  const [errorsByAcademy, setErrorsByAcademy] = useState<Record<string, string>>({});

  function handleRecalculate(academyId: string, academyName: string) {
    setPendingAcademyId(academyId);
    setErrorsByAcademy((previous) => {
      const next = { ...previous };
      delete next[academyId];
      return next;
    });
    startTransition(async () => {
      let message: string | null = null;
      try {
        const result = await recalculateUsageAction(academyId);
        if (!result.ok) message = result.error.message;
      } catch {
        message = NETWORK_ERROR_MESSAGE;
      }
      if (message) {
        setErrorsByAcademy((previous) => ({ ...previous, [academyId]: message }));
        showErrorToast(message);
      } else {
        showSuccessToast(`Usage recalculated for ${academyName}.`);
      }
      setPendingAcademyId(null);
    });
  }

  if (rows.length === 0) {
    return (
      <Section className="mb-8">
        <EmptyState message="No academies yet." icon={<Icon name="apartment" />} />
      </Section>
    );
  }

  return (
    <div className="@container mb-4">
      <ul role="list" className="grid grid-cols-1 gap-5 @[620px]:grid-cols-2 @[940px]:grid-cols-3">
        {rows.map((row) => {
          const { usage, limits } = row;
          const overLimit =
            usage && limits
              ? usage.branchCount >= limits.maxBranches ||
                usage.activeStudentsCount >= limits.maxStudents ||
                usage.activeStaffCount >= limits.maxStaff ||
                usage.courseCount >= limits.maxCourses ||
                usage.storageUsedBytes >= limits.maxStorageBytes
              : false;
          const working = isPending && pendingAcademyId === row.academyId;
          // calculatedAt crosses the server->client boundary as a string.
          const snapshot = usage ? new Date(usage.calculatedAt) : null;

          return (
            <li
              key={row.academyId}
              className={`flex flex-col rounded-card border bg-surface px-5 py-4 shadow-card ${
                overLimit ? "border-[#FCA5A5] ring-1 ring-[#FCA5A5]" : "border-border"
              }`}
            >
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link
                    href={`/platform/academies/${row.academyId}`}
                    className="font-semibold !text-ink no-underline [overflow-wrap:anywhere] hover:!text-brand hover:underline"
                  >
                    {row.academyName}
                  </Link>
                  <span className="mt-0.5 block text-xs text-muted [overflow-wrap:anywhere]" suppressHydrationWarning>
                    {row.planName ? planLabel(row.planName) : "No active plan"}
                    {snapshot &&
                      ` · snapshot ${formatDate(snapshot)}, ${snapshot.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}`}
                  </span>
                </div>
                {overLimit && (
                  <span className="shrink-0">
                    <Badge label="Over limit" tone="red" />
                  </span>
                )}
              </div>

              {!limits && <p className="mb-3 text-sm text-muted">No subscription plan, so there are no allowances to show.</p>}
              {limits && !usage && <p className="mb-3 text-sm text-muted">Not calculated yet. Recalculate to take a snapshot.</p>}

              {usage && limits && (
                <div className="mb-4 flex flex-col gap-3">
                  <UsageBar label="Branches" current={usage.branchCount} limit={limits.maxBranches} />
                  <UsageBar label="Students" current={usage.activeStudentsCount} limit={limits.maxStudents} />
                  <UsageBar label="Staff" current={usage.activeStaffCount} limit={limits.maxStaff} />
                  <UsageBar label="Courses" current={usage.courseCount} limit={limits.maxCourses} />
                  <UsageBar label="Storage (GB)" current={usage.storageUsedBytes} limit={limits.maxStorageBytes} format={formatGb} />
                </div>
              )}

              {errorsByAcademy[row.academyId] && (
                <div className="mb-3">
                  <ErrorMessage message={errorsByAcademy[row.academyId]} />
                </div>
              )}

              <div className="mt-auto">
                <button
                  type="button"
                  className={ROW_BTN}
                  disabled={working}
                  onClick={() => handleRecalculate(row.academyId, row.academyName)}
                >
                  {working ? "Recalculating…" : "Recalculate"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
