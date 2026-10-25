import { SkeletonHeader, SkeletonKv, SkeletonList, SkeletonPage, SkeletonTabs } from "@/app/academy/_shell/skeletons";
import { ACCOUNT_WRAP } from "./account-tabs";

/** Loading state for the shared account pages: the account tabs and the
 * page's real title stay visible; only the content is a placeholder. */
export function AccountSkeleton({ page }: { page: "settings" | "activity" }) {
  return (
    <SkeletonPage label={page === "settings" ? "account settings" : "activity"} wrap={ACCOUNT_WRAP}>
      <SkeletonTabs labels={["Account settings", "Activity"]} variant="underline" />
      {page === "settings" ? (
        <>
          <SkeletonHeader title="Account settings" description="Your profile, sign-in details and security." />
          <SkeletonKv rows={3} />
          <SkeletonKv rows={1} title={false} />
          <SkeletonKv rows={1} title={false} />
          <SkeletonList rows={3} avatar={false} />
        </>
      ) : (
        <>
          <SkeletonHeader title="Activity" description="Actions taken by your account. Only you can see this page." />
          <SkeletonList rows={8} avatar={false} />
        </>
      )}
    </SkeletonPage>
  );
}
