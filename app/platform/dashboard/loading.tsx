import { PAGE_WRAP, Section, TableWrap, td, th } from "@/app/academy/_shell/ui";

/** Shape-matched for the platform dashboard's real sections (KPI cards,
 * active-academies chart, pending-approvals/expiring-subscriptions/
 * recent-payments tables) — same `Pulse` convention as
 * app/academy/dashboard/loading.tsx (this module has no component library
 * of its own; it reuses the Academy shell's). The exact KPI card count is
 * capability-dependent and not worth guessing at exactly; this approximates
 * the full-permission case closely enough that nothing reflows dramatically
 * once real content streams in. */
function Pulse({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse motion-reduce:animate-none rounded-control bg-app ${className}`} />;
}

function TableSkeleton({ columns, rows = 4 }: { columns: string[]; rows?: number }) {
  return (
    <TableWrap>
      <thead>
        <tr>
          {columns.map((label) => (
            <th key={label} className={th}>
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rows }).map((_, index) => (
          <tr key={index}>
            {columns.map((_, columnIndex) => (
              <td key={columnIndex} className={td}>
                <Pulse className={columnIndex === columns.length - 1 ? "h-5 w-20 rounded-full" : "h-3.5 w-24"} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </TableWrap>
  );
}

export default function PlatformDashboardLoading() {
  return (
    <div className={PAGE_WRAP}>
      <div className="mb-6 flex flex-col gap-2">
        <Pulse className="h-7 w-32" />
        <Pulse className="h-4 w-80" />
      </div>
      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="flex flex-col gap-2 rounded-card border border-border bg-surface p-5 shadow-card">
              <div className="flex items-center justify-between">
                <Pulse className="h-3.5 w-24" />
                <Pulse className="h-9 w-9 rounded-[10px]" />
              </div>
              <Pulse className="h-8 w-16" />
            </div>
          ))}
        </div>

        <Section>
          <Pulse className="h-5 w-40" />
          <div className="mt-4">
            <Pulse className="h-56 w-full" />
          </div>
        </Section>

        <Section>
          <div className="flex items-center justify-between gap-2">
            <Pulse className="h-5 w-40" />
            <Pulse className="h-9 w-32" />
          </div>
          <div className="mt-4">
            <TableSkeleton columns={["Academy", "Submitted by", "Submitted"]} />
          </div>
        </Section>

        <Section>
          <div className="flex items-center justify-between gap-2">
            <Pulse className="h-5 w-48" />
            <Pulse className="h-9 w-32" />
          </div>
          <div className="mt-4">
            <TableSkeleton columns={["Academy", "Plan", "Ends", "Days left"]} />
          </div>
        </Section>

        <Section>
          <div className="flex items-center justify-between gap-2">
            <Pulse className="h-5 w-36" />
            <Pulse className="h-9 w-32" />
          </div>
          <div className="mt-4">
            <TableSkeleton columns={["Academy", "Amount", "Received", "Status"]} />
          </div>
        </Section>
      </div>
    </div>
  );
}
