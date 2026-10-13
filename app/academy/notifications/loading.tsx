import { PAGE_WRAP, Section } from "@/app/academy/_shell/ui";

/** Shape-matched for the real page's layout: a filter row + stacked
 * notification rows (icon, text lines, timestamp) — not a table, same
 * `Pulse` convention as app/academy/dashboard/loading.tsx. */
function Pulse({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse motion-reduce:animate-none rounded-control bg-app ${className}`} />;
}

export default function NotificationsLoading() {
  return (
    <div className={PAGE_WRAP}>
      <div className="mb-6 flex flex-col gap-2">
        <Pulse className="h-7 w-40" />
        <Pulse className="h-4 w-64" />
      </div>
      <div className="mb-5 flex gap-2">
        <Pulse className="h-8 w-20 rounded-full" />
        <Pulse className="h-8 w-24 rounded-full" />
      </div>
      <Section>
        <div className="flex flex-col divide-y divide-border">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="flex items-start gap-3 py-3">
              <Pulse className="h-8 w-8 shrink-0 rounded-full" />
              <div className="flex flex-1 flex-col gap-2">
                <Pulse className="h-3.5 w-3/4" />
                <Pulse className="h-3 w-1/3" />
              </div>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
