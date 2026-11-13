import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/marketing/seo";

/**
 * Crawl rules only — not access control. Private pages stay crawlable so
 * search engines can read their `noindex` metadata (a page blocked here can
 * still be listed from external links, without its noindex ever being seen).
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
