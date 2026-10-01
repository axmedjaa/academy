import type { TimetableGridSlot } from "@/lib/academies/timetable-grid";
import { DAYS_OF_WEEK, DAY_LABELS, formatTimetableTime } from "@/lib/academies/timetable-constants";
import { TableWrap, td, th } from "@/app/academy/_shell/ui";

/**
 * The weekly schedule view (approved review §12/§13) — reused as-is by both
 * the live page and the print view (via `timetable-print-view.tsx`), so the
 * two can never visually diverge in structure, only in their surrounding
 * chrome (filters/actions vs. a printable header).
 *
 * Rows are whatever distinct time ranges `buildTimetableGrid` found in the
 * given entries — never a fixed/invented slot system. A cell can hold more
 * than one entry (two legitimate, non-conflicting entries sharing a day and
 * time) and must render all of them, never just the first.
 */
export function WeeklyGrid({ slots }: { slots: TimetableGridSlot[] }) {
  if (slots.length === 0) {
    return <p className="rounded-card border border-border bg-app p-6 text-center text-sm text-muted">No timetable entries to show for this scope.</p>;
  }

  return (
    <TableWrap>
      <thead>
        <tr>
          <th className={th}>Time</th>
          {DAYS_OF_WEEK.map((day) => (
            <th key={day} className={th}>
              {DAY_LABELS[day]}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {slots.map((slot) => (
          <tr key={`${slot.startTime}-${slot.endTime}`}>
            <td className={`${td} whitespace-nowrap font-medium`}>
              {formatTimetableTime(slot.startTime)}–{formatTimetableTime(slot.endTime)}
            </td>
            {DAYS_OF_WEEK.map((day) => {
              const cellEntries = slot.byDay[day];
              return (
                <td key={day} className={`${td} align-top`}>
                  {cellEntries.length === 0 ? (
                    <span className="text-muted">—</span>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {cellEntries.map((entry) => (
                        <div key={entry.id} className="rounded-control border border-border bg-app px-2 py-1.5 text-xs leading-snug">
                          <div className="font-semibold text-ink">{entry.courseName}</div>
                          <div className="text-muted">{entry.batchName}</div>
                          {entry.trainerName && <div className="text-muted">{entry.trainerName}</div>}
                          {entry.room && <div className="text-muted">{entry.room}</div>}
                        </div>
                      ))}
                    </div>
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </TableWrap>
  );
}
