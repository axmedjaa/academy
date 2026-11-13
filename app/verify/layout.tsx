import type { Metadata } from "next";
import { NO_INDEX } from "@/lib/marketing/seo";

// Certificate verification pages show an individual's certificate details:
// reachable by anyone holding the code, but never listed in search results.
export const metadata: Metadata = { robots: NO_INDEX };

export default function VerifyLayout({ children }: LayoutProps<"/verify">) {
  return children;
}
