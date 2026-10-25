import {
  SkeletonCharts,
  SkeletonFilters,
  SkeletonHeader,
  SkeletonPage,
  SkeletonStatRow,
  SkeletonTable,
  SkeletonTabs,
} from "@/app/academy/_shell/skeletons";

export default function ReportsLoading() {
  return (
    <SkeletonPage label="reports">
      <SkeletonHeader title="Reports" description="Summaries built from the records in this academy. Every export is logged." actions={1} />
      <SkeletonTabs count={3} />
      <SkeletonFilters search={false} dropdowns={1} dates={2} />
      <SkeletonStatRow count={3} />
      <SkeletonCharts count={2} />
      <SkeletonTable headers={["Detail", "Count", "Share"]} stackBelow={600} rows={4} />
    </SkeletonPage>
  );
}
