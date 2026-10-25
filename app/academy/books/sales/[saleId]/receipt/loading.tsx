import {
  SkeletonDetailHeader,
  SkeletonPage,
  SkeletonPanel,
} from "@/app/academy/_shell/skeletons";

export default function BookSaleReceiptLoading() {
  return (
    <SkeletonPage label="receipt">
      <SkeletonDetailHeader backLabel="Back" actions={1} />
      <SkeletonPanel className="mx-auto h-[520px] max-w-[820px]" />
    </SkeletonPage>
  );
}
