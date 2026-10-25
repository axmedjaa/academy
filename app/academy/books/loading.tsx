import {
  SkeletonBento,
  SkeletonFilters,
  SkeletonHeader,
  SkeletonPage,
  SkeletonPanel,
  SkeletonTabs,
} from "@/app/academy/_shell/skeletons";

export default function BooksLoading() {
  return (
    <SkeletonPage label="books">
      <SkeletonHeader title="Books" description="Catalogue, stock and sales in one place." />
      <SkeletonBento side={3} />
      <SkeletonTabs labels={["Catalogue", "Stock", "Sales"]} />
      <SkeletonFilters />
      <SkeletonPanel className="h-64" />
    </SkeletonPage>
  );
}
