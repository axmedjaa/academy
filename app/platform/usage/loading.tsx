import { PAGE_WRAP, Section } from "@/app/academy/_shell/ui";

/** Shape-matched for per-academy usage bars vs. plan limits — not a plain
 * table, same `Pulse` convention as app/academy/dashboard/loading.tsx. */
function Pulse({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse motion-reduce:animate-none rounded-control bg-app ${className}`} />;
}

export default function UsageLoading() {
  return (
    <div className={PAGE_WRAP}>
      <div className="mb-6 flex flex-col gap-2">
        <Pulse className="h-7 w-32" />
      </div>
      <div className="flex flex-col gap-4">
        {Array.from({ length: 5 }).map((_, index) => (
          <Section key={index}>
            <Pulse className="h-3.5 w-32" />
            <div className="mt-3 flex flex-col gap-2">
              {Array.from({ length: 3 }).map((__, barIndex) => (
                <div key={barIndex} className="flex flex-col gap-1">
                  <div className="flex justify-between">
                    <Pulse className="h-3 w-16" />
                    <Pulse className="h-3 w-10" />
                  </div>
                  <Pulse className="h-1.5 w-full rounded-full" />
                </div>
              ))}
            </div>
          </Section>
        ))}
      </div>
    </div>
  );
}
