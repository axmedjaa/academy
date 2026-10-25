import {
  SkeletonHeader,
  SkeletonPage,
  SkeletonTable,
  SkeletonTabs,
} from "@/app/academy/_shell/skeletons";

export default function FinanceLoading() {
  return (
    <SkeletonPage label="finance">
      <SkeletonHeader title="Finance" description actions={2} />
      <SkeletonTabs count={4} />
      <SkeletonTable headers={["Student", "Charge", "Amount", "Due", "Status"]} stackBelow={760} rows={6} avatar />
    </SkeletonPage>
  );
}
