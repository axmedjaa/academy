"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Makes PaginationNav's plain page links (still real `<a href>`s, so
 * middle-click / "open in new tab" keep working) navigate on the client:
 * only the list re-renders, inside a transition, so the page never reloads
 * and the route's loading skeleton never replaces it. The old rows stay,
 * dimmed, until the new page arrives (`data-pagination-pending`, styled in
 * globals.css), then the view scrolls back to the list's top
 * (`[data-pagination-top]`, else the page top).
 */
export function PaginationLinks({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <div
      data-pagination-pending={pending ? "" : undefined}
      aria-busy={pending || undefined}
      onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[data-slot="pagination-link"]');
        if (!link || link.getAttribute("aria-current") === "page") return;
        event.preventDefault();
        const href = link.getAttribute("href");
        if (!href) return;
        startTransition(() => {
          router.push(href, { scroll: false });
        });
        const top = document.querySelector("[data-pagination-top]");
        const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (top) top.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
        else window.scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" });
      }}
      className="transition-opacity duration-150 data-[pagination-pending]:opacity-60"
    >
      {children}
    </div>
  );
}
