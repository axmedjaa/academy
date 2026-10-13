/**
 * Motion-polish pass — subtle page-transition on navigation within the
 * Academy console. `template.tsx` (unlike `layout.tsx`) remounts on every
 * navigation, which is what actually re-triggers the entrance animation per
 * page change; `layout.tsx` stays mounted and would only animate once.
 *
 * Reuses the already-registered `--animate-fade-in-up` keyframe
 * (app/globals.css) — the same one StatCard/dashboard cards use for
 * "content just appeared" — rather than introducing a second fade token.
 * `motion-safe:` keeps this at a static, instant render under
 * `prefers-reduced-motion: reduce`, same convention as every other
 * animation in this app. No new dependency; purely CSS via the existing
 * Tailwind `@theme` animation.
 */
export default function AcademyTemplate({ children }: { children: React.ReactNode }) {
  return <div className="motion-safe:animate-fade-in-up">{children}</div>;
}
