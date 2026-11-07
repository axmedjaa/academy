/**
 * Runs once when a Next.js server starts, before it serves requests
 * (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md).
 * Production refuses to start without a valid TRUSTED_PROXY_HOP_COUNT
 * (security audit SEC-M-02); see lib/http/proxy-trust-check.ts.
 *
 * The check uses Node-only APIs (process.exit), so it lives in a separate
 * module imported only on the Node.js runtime, as the instrumentation guide
 * recommends; the Edge build of this file never sees it.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
