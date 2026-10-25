import { SkeletonFilters, SkeletonPanel, SkeletonRegion } from "@/app/academy/_shell/skeletons";

/** While a Books tab loads: only the tab's content area. The header, summary
 * cards and tab bar come from the layout above and stay on screen. */
export default function BooksTabLoading() {
  return (
    <SkeletonRegion label="books">
      <SkeletonFilters />
      <SkeletonPanel className="h-64" />
    </SkeletonRegion>
  );
}
