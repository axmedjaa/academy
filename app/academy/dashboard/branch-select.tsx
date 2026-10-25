"use client";

import { useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";

/**
 * Dashboard branch filter (A01 "Showing all branches" caption). Writes
 * `?branch=<id>` and lets the server page re-render; the server only honours
 * ids from the caller's own `listBranches` result, so this control can never
 * widen what the user may see.
 */
export function BranchSelect({
  options,
  value,
}: {
  options: { id: string; name: string }[];
  value: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  return (
    <label className="flex items-center">
      <span className="sr-only">Branch</span>
      <select
        aria-label="Branch"
        value={value ?? ""}
        aria-busy={pending}
        disabled={pending}
        onChange={(event) => {
          const next = event.target.value;
          startTransition(() => {
            router.replace(next ? `${pathname}?branch=${encodeURIComponent(next)}` : pathname, { scroll: false });
          });
        }}
        className="h-10 max-w-[200px] rounded-lg border border-border-strong bg-surface px-2 text-[13px] text-ink disabled:opacity-60"
      >
        <option value="">All branches</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    </label>
  );
}
