import {
  SkeletonDetailHeader,
  SkeletonKv,
  SkeletonPage,
  SkeletonPanel,
  SkeletonTabs,
} from "@/app/academy/_shell/skeletons";

export default function StudentDetailLoading() {
  return (
    <SkeletonPage label="student">
      <SkeletonDetailHeader backLabel="All students" actions={2} />
      <SkeletonTabs labels={["Overview", "Fees", "Payments"]} />
      <SkeletonPanel className="h-[184px] sm:h-40" />
      <SkeletonKv rows={10} />
      <SkeletonPanel className="h-32" />
    </SkeletonPage>
  );
}
