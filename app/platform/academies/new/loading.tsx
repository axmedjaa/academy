import { SkeletonForm, SkeletonPage } from "@/app/academy/_shell/skeletons";

export default function RegisterAcademyLoading() {
  return (
    <SkeletonPage label="registration form">
      <span className="mb-3 inline-flex min-h-11 items-center text-sm font-semibold text-brand">‹ Back to academies</span>
      <div className="mx-auto w-full max-w-[720px] overflow-hidden rounded-card border border-border bg-surface shadow-card">
        <div className="border-t-4 border-[#F5B638] bg-brand px-5 py-6 text-center text-white">
          <h1 className="text-[22px] font-bold leading-tight">Register academy</h1>
          <p className="mt-1 text-[13px] text-white/90">Nothing is created until you confirm.</p>
        </div>
        <div className="p-2">
          <SkeletonForm fields={4} />
        </div>
      </div>
    </SkeletonPage>
  );
}
