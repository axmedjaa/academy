import { SkeletonRegion } from "@/app/academy/_shell/skeletons";
import { OrderDetailSkeleton } from "../../../books-skeleton";

/** While this Book Management section loads (design B11): its own layout
 * in outline. The hero, roadmap and tabs stay on screen from the layout. */
export default function Loading() {
  return (
    <SkeletonRegion label="order details">
      <OrderDetailSkeleton />
    </SkeletonRegion>
  );
}
