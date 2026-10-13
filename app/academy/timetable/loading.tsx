import { PAGE_WRAP, Section } from "@/app/academy/_shell/ui";

/** Shape-matched for the weekly day x time grid — not a plain table, same
 * `Pulse` convention as app/academy/dashboard/loading.tsx. */
function Pulse({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse motion-reduce:animate-none rounded-control bg-app ${className}`} />;
}

export default function TimetableLoading() {
  return (
    <div className={PAGE_WRAP}>
      <div className="mb-6 flex flex-col gap-2">
        <Pulse className="h-7 w-36" />
      </div>
      <div className="mb-5 flex gap-3">
        <Pulse className="h-9 w-40" />
        <Pulse className="h-9 w-40" />
      </div>
      <Section>
        <div className="grid grid-cols-6 gap-2">
          {Array.from({ length: 30 }).map((_, index) => (
            <Pulse key={index} className="h-12 w-full" />
          ))}
        </div>
      </Section>
    </div>
  );
}
