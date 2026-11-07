import { SkeletonRegion } from "@/app/academy/_shell/skeletons";
import { CampaignsSkeleton } from "../../books-skeleton";

/** While this Book Management section loads (design B11): its own layout
 * in outline. The hero, tabs and pills stay on screen from the layout. */
export default function Loading() {
  return (
    <SkeletonRegion label="pre-order campaigns">
      <CampaignsSkeleton />
    </SkeletonRegion>
  );
}
