import type { Metadata } from "next";

/** Used only outside production (next dev, Vitest) when NEXT_PUBLIC_SITE_URL is unset. */
const DEVELOPMENT_SITE_URL = "http://localhost:3000";

/**
 * Validates a site URL and normalizes it to its origin (scheme + host +
 * port; no path, query, hash or trailing slash).
 *
 * Production requires a value: a production build without one would publish
 * a sitemap, robots.txt and canonical URLs pointing at the wrong host, so it
 * fails the build instead. Outside production an unset value falls back to
 * localhost, so `next dev`, E2E and unit tests need no extra setup. An
 * invalid value is always an error.
 */
export function resolveSiteUrl(raw: string | undefined, nodeEnv: string | undefined): string {
  const value = raw?.trim();
  if (!value) {
    if (nodeEnv === "production") {
      throw new Error(
        "NEXT_PUBLIC_SITE_URL is required for a production build (e.g. https://example.com). " +
          "It sets the canonical domain used by the sitemap, robots.txt and metadata.",
      );
    }
    return DEVELOPMENT_SITE_URL;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`NEXT_PUBLIC_SITE_URL is not a valid URL: "${value}"`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`NEXT_PUBLIC_SITE_URL must use http or https: "${value}"`);
  }
  return url.origin;
}

/**
 * Canonical public origin of the site, used by app/layout.tsx (metadataBase),
 * the homepage canonical URL, app/sitemap.ts and app/robots.ts.
 *
 * Set by NEXT_PUBLIC_SITE_URL. Next.js inlines NEXT_PUBLIC_* variables at
 * `next build`, and the sitemap and robots.txt are prerendered then too, so
 * the value must be present in the build environment (the CI build step).
 * Changing it on the server afterwards has no effect until the next build.
 */
export const SITE_URL = resolveSiteUrl(process.env.NEXT_PUBLIC_SITE_URL, process.env.NODE_ENV);

/**
 * Keeps a page out of search results. Applied to private consoles, sign-in
 * and token pages, and certificate verification pages. This is an indexing
 * hint only — access control is still enforced by each page's own auth checks.
 */
export const NO_INDEX: Metadata["robots"] = { index: false, follow: false };
