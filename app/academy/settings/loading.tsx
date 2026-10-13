import { PAGE_WRAP, Section } from "@/app/academy/_shell/ui";

/** Shape-matched for a field-heavy settings form — not a table, same
 * `Pulse` convention as app/academy/dashboard/loading.tsx. */
function Pulse({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse motion-reduce:animate-none rounded-control bg-app ${className}`} />;
}

export default function SettingsLoading() {
  return (
    <div className={PAGE_WRAP}>
      <div className="mb-6 flex flex-col gap-2">
        <Pulse className="h-7 w-32" />
      </div>
      <Section className="flex flex-col gap-5">
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className="flex flex-col gap-1.5">
            <Pulse className="h-3 w-24" />
            <Pulse className="h-9 w-full max-w-md" />
          </div>
        ))}
        <Pulse className="h-9 w-24" />
      </Section>
    </div>
  );
}
