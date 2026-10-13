import { Card } from "@/lib/ui/auth-components";
import { color, spacing } from "@/lib/ui/theme";

/** Shape-matched skeleton for `/account/activity` — same per-route
 * `loading.tsx` convention as `/academy/audit-logs`/`/platform/audit-logs`
 * (see those routes' own `loading.tsx`), using this page's own inline-style
 * primitives (`lib/ui/auth-components.tsx`) rather than the academy shell's
 * `ListPageSkeleton`, since this route sits outside either console's shell —
 * same separation `/account/security` already keeps. */
export default function MyActivityLoading() {
  return (
    <div style={{ minHeight: "100vh", backgroundColor: color.bg, padding: spacing.xl }}>
      <div style={{ maxWidth: 860, margin: "0 auto", display: "flex", flexDirection: "column", gap: spacing.xl }}>
        <div className="animate-pulse" style={{ display: "flex", flexDirection: "column", gap: spacing.xs }}>
          <div style={{ height: 16, width: 140, borderRadius: 6, backgroundColor: color.border }} />
          <div style={{ height: 28, width: 200, borderRadius: 6, backgroundColor: color.border }} />
          <div style={{ height: 14, width: 360, borderRadius: 6, backgroundColor: color.border }} />
        </div>
        <Card>
          <div className="animate-pulse" style={{ display: "flex", flexDirection: "column", gap: spacing.sm }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} style={{ height: 36, borderRadius: 6, backgroundColor: color.border }} />
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
