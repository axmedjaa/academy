import { PAGE_WRAP, Section } from "@/app/academy/_shell/ui";

/** Shape-matched for a single printable receipt document — not a table or
 * list, same `Pulse` convention as app/academy/dashboard/loading.tsx. */
function Pulse({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse motion-reduce:animate-none rounded-control bg-app ${className}`} />;
}

export default function ReceiptLoading() {
  return (
    <div className={PAGE_WRAP}>
      <div className="mb-6 flex flex-col gap-2">
        <Pulse className="h-7 w-48" />
      </div>
      <Section className="mx-auto max-w-md">
        <div className="flex flex-col items-center gap-2 border-b border-border pb-4">
          <Pulse className="h-5 w-32" />
          <Pulse className="h-3 w-24" />
        </div>
        <div className="flex flex-col gap-3 py-4">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="flex justify-between">
              <Pulse className="h-3.5 w-24" />
              <Pulse className="h-3.5 w-20" />
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
