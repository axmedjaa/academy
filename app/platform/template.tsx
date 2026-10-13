/**
 * Motion-polish pass — subtle page-transition on navigation within the
 * Platform console. Same mechanism and reasoning as
 * app/academy/template.tsx; kept as two separate files (not a shared
 * layout) since `template.tsx` must live directly under each route segment
 * to remount on every navigation within that segment.
 */
export default function PlatformTemplate({ children }: { children: React.ReactNode }) {
  return <div className="motion-safe:animate-fade-in-up">{children}</div>;
}
