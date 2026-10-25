import {
  SkeletonForm,
  SkeletonPage,
} from "@/app/academy/_shell/skeletons";

export default function NewStaffLoading() {
  return (
    <SkeletonPage label="staff form">
      <div className="mx-auto max-w-[560px]">
        <span className="mb-3 inline-flex min-h-11 items-center text-sm font-semibold text-brand">‹ Back to staff</span>
        <SkeletonForm fields={8} />
      </div>
    </SkeletonPage>
  );
}
