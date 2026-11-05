import { SkeletonRegion } from "@/app/academy/_shell/skeletons";
import { ReportsSkeleton } from "../../books-skeleton";

/** While this Book Management section loads (design B11): its own layout
 * in outline. The hero, roadmap and tabs stay on screen from the layout. */
export default function Loading() {
  return (
    <SkeletonRegion label="reports">
      <ReportsSkeleton />
    </SkeletonRegion>
  );
}
