import { PAGE_WRAP, Section } from "@/app/academy/_shell/ui";

/** Shape-matched for the reports hub: filter bar + a table + a chart only
 * where the real page shows one — same `Pulse` convention as
 * app/academy/dashboard/loading.tsx. */
function Pulse({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse motion-reduce:animate-none rounded-control bg-app ${className}`} />;
}

export default function ReportsLoading() {
  return (
    <div className={PAGE_WRAP}>
      <div className="mb-6 flex flex-col gap-2">
        <Pulse className="h-7 w-36" />
        <Pulse className="h-4 w-64" />
      </div>
      <div className="mb-5 flex flex-wrap gap-3">
        <Pulse className="h-9 w-32" />
        <Pulse className="h-9 w-32" />
        <Pulse className="h-9 w-24" />
      </div>
      <Section className="mb-6">
        <Pulse className="h-40 w-full" />
      </Section>
      <Section>
        <div className="flex flex-col gap-3">
          {Array.from({ length: 5 }).map((_, index) => (
            <Pulse key={index} className="h-4 w-full" />
          ))}
        </div>
      </Section>
    </div>
  );
}
