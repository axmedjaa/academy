import { checkProxyTrustConfig } from "./lib/http/proxy-trust-check";

/**
 * Node.js-runtime startup checks, imported only from instrumentation.ts's
 * register() when NEXT_RUNTIME is "nodejs". See lib/http/proxy-trust-check.ts.
 */

// `next build` can load instrumentation while prerendering; the build has no
// proxy and must not need runtime settings. Only a running server is checked.
if (process.env.NEXT_PHASE !== "phase-production-build") {
  const result = checkProxyTrustConfig(process.env);
  if (!result.ok) {
    console.error(JSON.stringify({ level: "error", message: "startup.refused", reason: result.reason }));
    process.exit(1);
  }
}
