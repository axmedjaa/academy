import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/marketing/seo";

/**
 * Public pages only. Consoles, account, sign-in and certificate verification
 * pages are deliberately left out (they carry noindex metadata instead).
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${SITE_URL}/`,
      changeFrequency: "monthly",
      priority: 1,
    },
  ];
}
