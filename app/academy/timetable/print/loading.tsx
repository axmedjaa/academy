import {
  SkeletonDetailHeader,
  SkeletonPage,
  SkeletonPanel,
} from "@/app/academy/_shell/skeletons";

export default function TimetablePrintLoading() {
  return (
    <SkeletonPage label="timetable">
      <SkeletonDetailHeader backLabel="Back" actions={1} />
      <SkeletonPanel className="mx-auto h-[520px] max-w-[820px]" />
    </SkeletonPage>
  );
}
