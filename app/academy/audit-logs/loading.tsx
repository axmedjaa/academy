import {
  SkeletonChips,
  SkeletonFilters,
  SkeletonHeader,
  SkeletonPage,
  SkeletonTable,
} from "@/app/academy/_shell/skeletons";

export default function AuditLogsLoading() {
  return (
    <SkeletonPage label="audit log">
      <SkeletonHeader title="Audit log" description="Actions taken in this academy. Only the owner and administrator can see this page." actions={1} />
      <SkeletonChips count={3} />
      <SkeletonFilters search={false} dropdowns={2} dates={2} />
      <SkeletonTable headers={["When", "Who", "What happened", "Record", "Result"]} stackBelow={900} rows={8} avatar />
    </SkeletonPage>
  );
}
