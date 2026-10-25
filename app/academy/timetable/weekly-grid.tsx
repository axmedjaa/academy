import type { TimetableGridSlot } from "@/lib/academies/timetable-grid";
import { DAYS_OF_WEEK, DAY_LABELS, formatTimetableTime, type TimetableDay } from "@/lib/academies/timetable-constants";

/**
 * The live page's weekly timetable, in the design's timetable card style
 * (academy-engine.js `tt` block): a TIME column plus one column per day
 * (Saturday first; Friday only when something meets that day), each class
 * as a small card with a left bar in its branch colour — batch code,
 * course, trainer · room. Still a real <table> for the wide layout; below
 * 700px of container width it becomes the design's day-by-day list.
 *
 * Rows are whatever distinct time ranges `buildTimetableGrid` found — never
 * an invented slot system — and a cell renders every entry it holds.
 * The printable view (print/timetable-print-view.tsx) renders its own
 * table and print stylesheet; it does not use this component.
 */

export interface BranchTone {
  card: string;
  code: string;
  bar: string;
  dot: string;
}

const TONES: BranchTone[] = [
  { card: "bg-brand-tint border-l-brand", code: "text-brand", bar: "bg-brand", dot: "bg-brand" },
  { card: "bg-[#EFF6FF] border-l-[#1E40AF]", code: "text-[#1E40AF]", bar: "bg-[#1E40AF]", dot: "bg-[#1E40AF]" },
  { card: "bg-[#ECFDF5] border-l-[#047857]", code: "text-[#047857]", bar: "bg-[#047857]", dot: "bg-[#047857]" },
  { card: "bg-[#FFFBEB] border-l-[#B45309]", code: "text-[#92400E]", bar: "bg-[#B45309]", dot: "bg-[#B45309]" },
];

/** Stable colour per branch, by the branch's position in the academy's
 * branch list (the design colours its two branches burgundy and blue). */
export function branchToneFor(branchOrder: string[]) {
  return (branchId: string): BranchTone => {
    const index = branchOrder.indexOf(branchId);
    return TONES[(index < 0 ? 0 : index) % TONES.length];
  };
}

export function WeeklyGrid({
  slots,
  toneFor,
  batchCodeById,
}: {
  slots: TimetableGridSlot[];
  toneFor: (branchId: string) => BranchTone;
  batchCodeById: Map<string, string>;
}) {
  if (slots.length === 0) {
    return <div className="px-4 py-10 text-center text-muted">No classes scheduled yet.</div>;
  }

  const days: TimetableDay[] = DAYS_OF_WEEK.filter(
    (day) => day !== "fri" || slots.some((slot) => slot.byDay.fri.length > 0),
  );

  const entryCard = (entry: TimetableGridSlot["byDay"][TimetableDay][number]) => {
    const tone = toneFor(entry.branchId);
    return (
      <div key={entry.id} className={`rounded-lg border-l-[3px] px-3 py-2 text-xs leading-snug ${tone.card}`}>
        <div className={`text-[13px] font-bold ${tone.code}`}>{batchCodeById.get(entry.batchId) ?? entry.batchName}</div>
        <div className="font-semibold text-ink">{entry.courseName}</div>
        {(entry.trainerName || entry.room) && (
          <div className="text-muted">{[entry.trainerName, entry.room].filter(Boolean).join(" · ")}</div>
        )}
      </div>
    );
  };

  return (
    <div className="@container">
      <div className="hidden @[700px]:block">
        <table className="w-full table-fixed border-collapse text-sm">
          <thead>
            <tr className="bg-[#FAFBFC]">
              <th className="w-24 border-b border-border px-3 py-3 text-left text-xs font-bold uppercase tracking-[0.05em] text-[#374151]">
                Time
              </th>
              {days.map((day) => (
                <th
                  key={day}
                  className="border-b border-l border-border px-3 py-3 text-left text-xs font-bold uppercase tracking-[0.05em] text-[#374151]"
                >
                  {DAY_LABELS[day]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {slots.map((slot) => (
              <tr key={`${slot.startTime}-${slot.endTime}`} className="break-inside-avoid">
                <td className="border-b border-border px-3 py-3.5 align-top font-semibold tabular-nums text-ink">
                  {formatTimetableTime(slot.startTime)} to {formatTimetableTime(slot.endTime)}
                </td>
                {days.map((day) => (
                  <td key={day} className="border-b border-l border-border p-2 align-top">
                    <div className="flex flex-col gap-2">{slot.byDay[day].map(entryCard)}</div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-3 p-4 @[700px]:hidden">
        {days.map((day) => {
          const dayEntries = slots
            .flatMap((slot) => slot.byDay[day].map((entry) => ({ slot, entry })))
            .sort((a, b) => a.slot.startTime.localeCompare(b.slot.startTime));
          return (
            <div key={day} className="rounded-card border border-border bg-surface p-3.5">
              <div className="mb-2 font-semibold text-ink">{DAY_LABELS[day]}</div>
              {dayEntries.length === 0 ? (
                <div className="text-[13px] text-muted">No classes.</div>
              ) : (
                <div className="flex flex-col gap-2">
                  {dayEntries.map(({ slot, entry }) => (
                    <div key={entry.id} className="flex gap-3">
                      <div className="w-[88px] shrink-0 pt-2 text-xs font-semibold tabular-nums text-[#374151]">
                        {formatTimetableTime(slot.startTime)} to {formatTimetableTime(slot.endTime)}
                      </div>
                      <div className="min-w-0 flex-1">{entryCard(entry)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
