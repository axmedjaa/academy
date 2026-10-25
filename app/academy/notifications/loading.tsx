import {
  SkeletonHeader,
  SkeletonList,
  SkeletonPage,
  SkeletonTabs,
} from "@/app/academy/_shell/skeletons";
import { ACCOUNT_WRAP } from "@/app/account/account-tabs";

export default function NotificationsLoading() {
  return (
    <SkeletonPage label="notifications" wrap={ACCOUNT_WRAP}>
      <SkeletonTabs labels={["Account settings", "Activity", "Notifications"]} variant="underline" />
      <SkeletonHeader title="Notifications" description="Approvals, results, receipts, certificates, subscription and sign-in events for your account." />
      <SkeletonList rows={6} trailing />
    </SkeletonPage>
  );
}
