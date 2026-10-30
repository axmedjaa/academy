import { SkeletonDetailHeader, SkeletonKv, SkeletonPage, SkeletonPanel } from "@/app/academy/_shell/skeletons";

export default function AcademyDetailLoading() {
  return (
    <SkeletonPage label="academy">
      <SkeletonDetailHeader backLabel="Academies" />
      <div className="grid grid-cols-1 items-start gap-x-6 lg:grid-cols-2">
        <div>
          <SkeletonKv rows={6} />
          <SkeletonKv rows={4} />
          <SkeletonKv rows={4} />
        </div>
        <div>
          <SkeletonPanel className="h-48" />
          <SkeletonKv rows={3} />
          <SkeletonPanel className="h-64" />
        </div>
      </div>
    </SkeletonPage>
  );
}
