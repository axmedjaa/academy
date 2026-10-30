import { Bone } from "@/app/academy/_shell/skeletons";
import { AuthCard } from "@/lib/ui/auth-components";

/** Shown while the email-change link is checked and applied. */
export default function VerifyEmailLoading() {
  return (
    <AuthCard title="Verifying email address">
      <div role="status" aria-busy="true" aria-live="polite" className="flex flex-col gap-2">
        <span className="sr-only">Verifying your email address…</span>
        <Bone className="h-4 w-full" />
        <Bone className="h-4 w-2/3" />
      </div>
    </AuthCard>
  );
}
