import { PAGE_WRAP } from "@/app/academy/_shell/ui";

/** Shape-matched skeleton for `/academy/students` — mirrors the real
 * page's actual composition after the Impeccable redesign pass: one
 * bordered surface (filter row + hairline divider + table), not the
 * separate filter-card-then-table-card shape this skeleton originally
 * matched. `animate-pulse` is Tailwind's built-in utility;
 * `motion-reduce:animate-none` keeps it a static placeholder under
 * `prefers-reduced-motion: reduce`. */
function Pulse({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse motion-reduce:animate-none rounded-control bg-app ${className}`} />;
}

export default function StudentsLoading() {
  return (
    <div className={PAGE_WRAP}>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <Pulse className="h-7 w-28" />
          <Pulse className="h-4 w-80" />
        </div>
        <Pulse className="h-9 w-36" />
      </div>

      <div className="overflow-hidden rounded-card border border-border bg-surface shadow-card">
        <div className="border-b border-border p-5">
          <div className="flex flex-wrap items-end gap-3">
            <Pulse className="h-[38px] min-w-[240px] flex-1" />
            <Pulse className="h-[38px] w-36" />
            <Pulse className="h-[38px] w-24" />
          </div>
        </div>

        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr>
              <th className="border-b border-border bg-app px-4 py-2.5 text-left">
                <Pulse className="h-3 w-16" />
              </th>
              <th className="border-b border-border bg-app px-4 py-2.5 text-left">
                <Pulse className="h-3 w-14" />
              </th>
              <th className="hidden border-b border-border bg-app px-4 py-2.5 text-left md:table-cell">
                <Pulse className="h-3 w-20" />
              </th>
              <th className="border-b border-border bg-app px-4 py-2.5 text-right">
                <Pulse className="ml-auto h-3 w-16" />
              </th>
              <th className="border-b border-border bg-app px-4 py-2.5 text-left">
                <Pulse className="h-3 w-24" />
              </th>
              <th className="border-b border-border bg-app px-4 py-2.5 text-right">
                <Pulse className="ml-auto h-3 w-12" />
              </th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 8 }).map((_, index) => (
              <tr key={index}>
                <td className="border-b border-border px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Pulse className="h-9 w-9 shrink-0 rounded-full" />
                    <div className="flex flex-col gap-1.5">
                      <Pulse className="h-3.5 w-32" />
                      <Pulse className="h-3 w-20" />
                    </div>
                  </div>
                </td>
                <td className="border-b border-border px-4 py-3">
                  <Pulse className="h-5 w-16 rounded-full" />
                </td>
                <td className="hidden border-b border-border px-4 py-3 md:table-cell">
                  <Pulse className="h-3.5 w-36" />
                </td>
                <td className="border-b border-border px-4 py-3 text-right">
                  <Pulse className="ml-auto h-3.5 w-16" />
                </td>
                <td className="border-b border-border px-4 py-3">
                  <Pulse className="h-5 w-24 rounded-full" />
                </td>
                <td className="border-b border-border px-4 py-3 text-right">
                  <Pulse className="ml-auto h-8 w-8 rounded-control" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
