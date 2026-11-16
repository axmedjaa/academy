import {
  SkeletonFilters,
  SkeletonHeader,
  SkeletonPage,
  SkeletonStatRow,
  SkeletonTable,
} from "@/app/academy/_shell/skeletons";

/** While Batches loads: header, the three count cards,
 * search and filters, then the table — the page's own layout in outline. */
export default function BatchesLoading() {
  return (
    <SkeletonPage label="batches">
      <SkeletonHeader
        title="Batches"
        description="Cohorts at one branch. A batch can run one course or several."
        actions={1}
      />
      <SkeletonStatRow count={3} />
      <SkeletonFilters search dropdowns={2} />
      <SkeletonTable headers={["Batch", "Courses", "Branch", "Starts", "Status", "Roster"]} stackBelow={900} rows={6} actions />
    </SkeletonPage>
  );
}
