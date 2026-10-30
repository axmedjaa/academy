import { SkeletonHeader, SkeletonPage } from "@/app/academy/_shell/skeletons";
import { SkeletonRowCards } from "../_shared/skeletons";

export default function SubscriptionsLoading() {
  return (
    <SkeletonPage label="subscriptions">
      <SkeletonHeader title="Subscriptions" description="Subscription state and renewals for every academy." />
      <SkeletonRowCards count={6} />
    </SkeletonPage>
  );
}
