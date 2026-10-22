"use client";

import { useEffect, useState } from "react";

/**
 * Sidebar/dashboard-redesign pass — the Afoogy reference video
 * (afoogy_animated_dashboard.mp4) shows each StatCard's number counting up
 * from 0 to its real value once, on first paint. This reproduces that
 * exact effect and nothing more: it reveals an already-known, real number
 * (never an invented or interpolated one — the end value is always
 * `value`, the same number the server already computed), re-animates only
 * when `value` itself changes (the effect's own dependency array already
 * guarantees that — an extra "only once" ref guard was tried here and
 * removed: under React StrictMode's dev-only mount→cleanup→remount, the
 * cleanup cancels the first animation frame and a ref-based guard, which
 * survives that remount, then blocks the real run from ever starting,
 * leaving every StatCard stuck at its initial 0), and snaps straight to
 * the final value under `prefers-reduced-motion: reduce` instead of
 * animating.
 *
 * Isolated in its own "use client" leaf rather than added to
 * `app/academy/_shell/ui.tsx` directly — that file has no "use client" of
 * its own today (every component it exports is server-renderable as-is),
 * and this is the one case in `StatCard` that genuinely needs client-side
 * state, so it stays a small, separate island per this codebase's existing
 * convention (app/_console/console-shell.tsx are the same kind of
 * isolated client leaf for their own interactivity).
 *
 * Only ever given a plain count (students, staff, charges...) — every
 * money figure in this app's StatCards renders as pre-formatted text in
 * `hint`, never as the tweened headline number, so there is no currency
 * string to parse or mis-animate here.
 */
export function CountUpValue({ value, durationMs = 650 }: { value: number; durationMs?: number }) {
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const start = performance.now();
    let frame: number;
    function tick(now: number) {
      if (reduceMotion) {
        setDisplay(value);
        return;
      }
      const progress = Math.min((now - start) / durationMs, 1);
      const easedOut = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(value * easedOut));
      if (progress < 1) frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, durationMs]);

  return <>{display.toLocaleString()}</>;
}
