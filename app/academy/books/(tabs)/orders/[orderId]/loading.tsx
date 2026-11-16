import { SkeletonRegion } from "@/app/academy/_shell/skeletons";
import { OrderDetailSkeleton } from "../../../books-skeleton";

/** While an order's page loads: its layout in outline. */
export default function Loading() {
  return (
    <SkeletonRegion label="order">
      <OrderDetailSkeleton />
    </SkeletonRegion>
  );
}
