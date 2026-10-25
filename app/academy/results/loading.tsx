import {
  SkeletonChips,
  SkeletonFilters,
  SkeletonHeader,
  SkeletonPage,
  SkeletonTable,
} from "@/app/academy/_shell/skeletons";

export default function ResultsLoading() {
  return (
    <SkeletonPage label="results">
      <SkeletonHeader title="Results" description="Marks by exam. Review, approve and publish here." />
      <SkeletonFilters />
      <SkeletonChips count={6} />
      <SkeletonTable headers={["Student", "Marks", "Status", "Grade"]} stackBelow={760} rows={5} actions />
    </SkeletonPage>
  );
}
