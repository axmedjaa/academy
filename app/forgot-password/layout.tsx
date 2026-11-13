import type { Metadata } from "next";
import { NO_INDEX } from "@/lib/marketing/seo";

// The page is a client component, so its metadata lives here.
export const metadata: Metadata = { robots: NO_INDEX };

export default function ForgotPasswordLayout({ children }: LayoutProps<"/forgot-password">) {
  return children;
}
