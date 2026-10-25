import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next.js's dev server blocks cross-origin requests to dev-only assets/
  // endpoints by default, allowing only `localhost` and the origin it was
  // started with — see node_modules/next/dist/docs/.../allowedDevOrigins.md.
  // Testing on a phone through a tunnel (e.g. Cloudflare Quick Tunnel,
  // `<random>.trycloudflare.com`) arrives as a different origin, so without
  // this the dev server silently blocks the client JS from hydrating —
  // the static HTML/CSS still renders, but nothing interactive (menu
  // button, forms, etc.) responds. `*.trycloudflare.com` covers Quick
  // Tunnel's randomly-generated subdomain every time it's restarted,
  // without needing to hardcode today's specific hostname. Dev-only
  // concern — has no effect on `next build`/production.
  allowedDevOrigins: ["*.trycloudflare.com"],

  // Playwright's isolated e2e webServer (playwright.config.ts) runs a
  // second `next dev` instance concurrently with the developer's own dev
  // server, against a separate Neon test branch — see
  // docs/testing-database.md. Both processes must not write to the same
  // `.next` build cache at once. E2E_DIST_DIR is set only by that
  // webServer's own `env`; every other invocation (normal `next dev`/
  // `next build`, or `next dev` run by hand) is unaffected and keeps the
  // default `.next`.
  distDir: process.env.E2E_DIST_DIR || ".next",
};

export default nextConfig;
