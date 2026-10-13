import { PAGE_WRAP, Section } from "@/app/academy/_shell/ui";

/** Shape-matched for the revenue reports page: group-by filters + a
 * collected/expected split + a table — same `Pulse` convention as
 * app/academy/dashboard/loading.tsx. */
function Pulse({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse motion-reduce:animate-none rounded-control bg-app ${className}`} />;
}

export default function PlatformReportsLoading() {
  return (
    <div className={PAGE_WRAP}>
      <div className="mb-6 flex flex-col gap-2">
        <Pulse className="h-7 w-36" />
      </div>
      <div className="mb-5 flex flex-wrap gap-3">
        <Pulse className="h-9 w-32" />
        <Pulse className="h-9 w-32" />
      </div>
      <div className="mb-6 grid grid-cols-2 gap-4">
        <Section>
          <Pulse className="h-3.5 w-20" />
          <Pulse className="mt-2 h-7 w-24" />
        </Section>
        <Section>
          <Pulse className="h-3.5 w-20" />
          <Pulse className="mt-2 h-7 w-24" />
        </Section>
      </div>
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
