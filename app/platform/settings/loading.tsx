import { PAGE_WRAP, Section } from "@/app/academy/_shell/ui";

/** Shape-matched for a simple toggle-form settings page — not a table, same
 * `Pulse` convention as app/academy/dashboard/loading.tsx. */
function Pulse({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse motion-reduce:animate-none rounded-control bg-app ${className}`} />;
}

export default function PlatformSettingsLoading() {
  return (
    <div className={PAGE_WRAP}>
      <div className="mb-6 flex flex-col gap-2">
        <Pulse className="h-7 w-32" />
      </div>
      <Section className="flex flex-col gap-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="flex items-center justify-between">
            <Pulse className="h-3.5 w-40" />
            <Pulse className="h-6 w-11 rounded-full" />
          </div>
        ))}
      </Section>
    </div>
  );
}
