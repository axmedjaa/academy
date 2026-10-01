import { PAGE_WRAP, Section, TableWrap, td, th } from "@/app/academy/_shell/ui";

/** Shape-matched skeleton mirroring the real page's actual sections (stat
 * grid, Recent Payments table, Usage bars) — same `Pulse` convention as
 * app/academy/students/loading.tsx, which superseded the older generic
 * `SkeletonBlock` stack this file used before (a flat row of same-size
 * blocks that didn't resemble the real layout, so the page visibly jumped
 * once real data replaced it). The exact stat-card count and alert banners
 * are role/data-dependent and not worth guessing at — this approximates
 * the common case (no alerts, 4-5 cards) closely enough that nothing
 * reflows dramatically once the real content streams in. */
function Pulse({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse motion-reduce:animate-none rounded-control bg-app ${className}`} />;
}

export default function DashboardLoading() {
  return (
    <div className={PAGE_WRAP}>
      <div className="mb-6 flex flex-col gap-2">
        <Pulse className="h-7 w-32" />
        <Pulse className="h-4 w-64" />
      </div>

      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="flex flex-col gap-2 rounded-card border border-border bg-surface p-5 shadow-card">
              <div className="flex items-center justify-between">
                <Pulse className="h-3.5 w-24" />
                <Pulse className="h-5 w-5 rounded-full" />
              </div>
              <Pulse className="h-7 w-16" />
            </div>
          ))}
        </div>

        <Section>
          <div className="flex items-center justify-between">
            <Pulse className="h-5 w-32" />
            <Pulse className="h-9 w-20" />
          </div>
          <div className="mt-4">
            <TableWrap>
              <thead>
                <tr>
                  <th className={th}>Student</th>
                  <th className={th}>Amount</th>
                  <th className={th}>Date</th>
                  <th className={th}>Method</th>
                  <th className={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 5 }).map((_, index) => (
                  <tr key={index}>
                    <td className={td}>
                      <div className="flex items-center gap-3">
                        <Pulse className="h-8 w-8 shrink-0 rounded-full" />
                        <Pulse className="h-3.5 w-28" />
                      </div>
                    </td>
                    <td className={td}>
                      <Pulse className="h-3.5 w-16" />
                    </td>
                    <td className={td}>
                      <Pulse className="h-3.5 w-20" />
                    </td>
                    <td className={td}>
                      <Pulse className="h-3.5 w-20" />
                    </td>
                    <td className={td}>
                      <Pulse className="h-5 w-20 rounded-full" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          </div>
        </Section>

        <Section>
          <Pulse className="h-5 w-20" />
          <div className="mt-4 flex flex-col gap-3">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="flex flex-col gap-1.5">
                <div className="flex justify-between">
                  <Pulse className="h-3 w-16" />
                  <Pulse className="h-3 w-10" />
                </div>
                <Pulse className="h-1.5 w-full rounded-full" />
              </div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}
