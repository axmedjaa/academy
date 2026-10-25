import {
  SkeletonFilters,
  SkeletonHeader,
  SkeletonList,
  SkeletonPage,
} from "@/app/academy/_shell/skeletons";

export default function IdCardsLoading() {
  return (
    <SkeletonPage label="ID cards">
      <SkeletonHeader title="ID cards" description />
      <SkeletonFilters />
      <SkeletonList rows={8} />
    </SkeletonPage>
  );
}
