"use client";

import { useEffect } from "react";
import type { TimetablePrintData } from "@/lib/academies/timetable-print";
import { DAYS_OF_WEEK, DAY_LABELS, formatTimetableTime } from "@/lib/academies/timetable-constants";
import { Button, LinkButton } from "@/app/academy/_shell/ui";
import styles from "./timetable-print.module.css";

interface Props {
  data: TimetablePrintData;
  /** Same one-click-print convention as every other print view in this
   * codebase (`?autoprint=1`, receipt-print-view.tsx / certificate-print-
   * view.tsx / book-sale-receipt-view.tsx). */
  autoPrint: boolean;
}

function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/** "Branch: Main Branch" when filtered, "Branch: All Branches" when not —
 * the printed header must never be ambiguous about what scope it covers
 * (approved review §16/§17). */
function scopeLine(label: string, value: string | null, allLabel: string): { label: string; value: string } {
  return { label, value: value ?? allLabel };
}

export function TimetablePrintView({ data, autoPrint }: Props) {
  const { academy, scope, generatedAt, slots } = data;

  useEffect(() => {
    if (autoPrint) window.print();
    // Fires once, on mount — same convention as every other print view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scopeLines = [
    scopeLine("Branch", scope.branchName, "All Branches"),
    scopeLine("Course", scope.courseName, "All Courses"),
    scopeLine("Batch", scope.batchName, "All Batches"),
    ...(scope.instructorName ? [{ label: "Instructor", value: scope.instructorName }] : []),
  ];

  return (
    <div className={styles.page}>
      <div className={`${styles.actions} ${styles.noPrint}`}>
        <LinkButton href="/academy/timetable" variant="secondary">
          ← Back to Timetable
        </LinkButton>
        <div className="flex-1" />
        <Button type="button" onClick={() => window.print()}>
          Print Timetable
        </Button>
      </div>

      <div className={styles.sheet}>
        <div className={styles.header}>
          <div>
            {academy.logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element -- short-lived signed R2 URL, same convention as every other print view here.
              <img src={academy.logoUrl} alt={academy.name} className={styles.logo} />
            )}
            <div className={styles.academyName}>{academy.name}</div>
          </div>
          <div className={styles.title}>Weekly Timetable</div>
        </div>

        <div className={styles.scopeGrid}>
          {scopeLines.map(({ label, value }) => (
            <div key={label}>
              <span className={styles.scopeLabel}>{label}:</span>
              <span className={styles.scopeValue}>{value}</span>
            </div>
          ))}
        </div>

        <div className={styles.gridWrap}>
          {slots.length === 0 ? (
            <p style={{ fontSize: "0.8rem", color: "#6b7280" }}>No timetable entries match this scope.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  {DAYS_OF_WEEK.map((day) => (
                    <th key={day}>{DAY_LABELS[day]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {slots.map((slot) => (
                  <tr key={`${slot.startTime}-${slot.endTime}`}>
                    <td>
                      {formatTimetableTime(slot.startTime)}–{formatTimetableTime(slot.endTime)}
                    </td>
                    {DAYS_OF_WEEK.map((day) => {
                      const cellEntries = slot.byDay[day];
                      return (
                        <td key={day}>
                          {cellEntries.length === 0
                            ? "—"
                            : cellEntries.map((entry) => (
                                <div key={entry.id} style={{ marginBottom: "1.5mm" }}>
                                  <div style={{ fontWeight: 700 }}>{entry.courseName}</div>
                                  <div>{entry.batchName}</div>
                                  {entry.trainerName && <div>{entry.trainerName}</div>}
                                  {entry.room && <div>{entry.room}</div>}
                                </div>
                              ))}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className={styles.footer}>
          Printed {formatDateTime(generatedAt)} — {academy.name}
        </div>
      </div>
    </div>
  );
}
