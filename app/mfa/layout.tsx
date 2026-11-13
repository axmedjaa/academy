import type { Metadata } from "next";
import { NO_INDEX } from "@/lib/marketing/seo";

export const metadata: Metadata = { robots: NO_INDEX };

export default function MfaLayout({ children }: LayoutProps<"/mfa">) {
  return children;
}
