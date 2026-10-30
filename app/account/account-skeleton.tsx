import { SkeletonHeader, SkeletonKv, SkeletonList, SkeletonPage, SkeletonTabs } from "@/app/academy/_shell/skeletons";
import { ACCOUNT_WRAP } from "./account-tabs";

const NOTIFICATIONS_DESCRIPTION =
  "Approvals, results, receipts, certificates, subscription and sign-in events for your account.";

/** Loading state for the shared account pages: the account tabs and the
 * page's real title stay visible; only the content is a placeholder. */
export function AccountSkeleton({ page }: { page: "settings" | "activity" | "notifications" }) {
  return (
    <SkeletonPage label={page === "settings" ? "account settings" : page} wrap={ACCOUNT_WRAP}>
      <SkeletonTabs labels={["Account settings", "Activity", "Notifications"]} variant="underline" />
      {page === "settings" && (
        <>
          <SkeletonHeader title="Account settings" description="Your profile, sign-in details and security." />
          <SkeletonKv rows={3} />
          <SkeletonKv rows={1} title={false} />
          <SkeletonKv rows={1} title={false} />
          <SkeletonList rows={3} avatar={false} />
        </>
      )}
      {page === "activity" && (
        <>
          <SkeletonHeader title="Activity" description="Actions taken by your account. Only you can see this page." />
          <SkeletonList rows={8} avatar={false} />
        </>
      )}
      {page === "notifications" && (
        <>
          <SkeletonHeader title="Notifications" description={NOTIFICATIONS_DESCRIPTION} />
          <SkeletonList rows={6} trailing />
        </>
      )}
    </SkeletonPage>
  );
}
