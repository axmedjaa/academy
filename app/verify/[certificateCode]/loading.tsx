import { Bone } from "@/app/academy/_shell/skeletons";
import { AuthLogo } from "@/lib/ui/auth-components";
import { color, radius, spacing } from "@/lib/ui/theme";

/** Public certificate check: the real heading stays; the lookup form and
 * the result card are placeholders while the code is verified. */
export default function VerifyCertificateLoading() {
  return (
    <div style={{ minHeight: "100vh", backgroundColor: color.bg, padding: `${spacing.xxl} ${spacing.md}` }}>
      <div style={{ maxWidth: 560, margin: "0 auto" }} role="status" aria-busy="true" aria-live="polite">
        <span className="sr-only">Checking certificate…</span>
        <AuthLogo />
        <div style={{ textAlign: "center", marginBottom: spacing.xl }}>
          <h1 style={{ margin: 0, fontSize: "1.6rem", color: color.text }}>Verify Certificate</h1>
          <p style={{ margin: 0, marginTop: spacing.xxs, fontSize: "0.9rem", color: color.textMuted }}>
            Enter a certificate code to check whether it was genuinely issued by this academy.
          </p>
        </div>
        <div className="flex gap-2">
          <Bone className="h-11 flex-1 rounded-lg" />
          <Bone className="h-11 w-24 rounded-lg" />
        </div>
        <div
          style={{
            marginTop: spacing.xl,
            backgroundColor: color.card,
            border: `1px solid ${color.border}`,
            borderRadius: radius.card,
            padding: spacing.lg,
          }}
        >
          <Bone className="h-10 w-full rounded-lg" />
          <div className="mt-5 flex flex-col gap-4">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="flex flex-col gap-1.5">
                <Bone className="h-3 w-24" />
                <Bone className="h-4 w-56 max-w-full" />
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
