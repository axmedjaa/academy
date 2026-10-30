import { SkeletonFilters, SkeletonHeader, SkeletonPage, SkeletonTable } from "@/app/academy/_shell/skeletons";

export default function PlatformAuditLogsLoading() {
  return (
    <SkeletonPage label="audit log">
      <SkeletonHeader title="Audit log" description="Every platform action, with before and after values." />
      <SkeletonFilters dropdowns={1} dates={2} />
      <SkeletonTable headers={["When", "Actor", "Action", "Entity", "Result"]} rows={8} actions />
    </SkeletonPage>
  );
}
