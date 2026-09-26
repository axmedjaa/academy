import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Standard shadcn/ui helper — merges conditional class lists and resolves
 * conflicting Tailwind utility classes (e.g. `p-2` vs `p-4`) in favor of the
 * later one, instead of leaving both in the className string. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
