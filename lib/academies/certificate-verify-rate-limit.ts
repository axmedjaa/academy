import { checkRateLimit, type RateLimitResult } from "@/lib/rate-limit";
import { env } from "@/lib/env";

// PLAN.md Phase 5, Item 62 — "/verify/[certificateCode]... rate-limited [per
// IP] and logged." Same "endpoint named, no threshold given" gap as
// lib/auth/login-rate-limit.ts and lib/auth/forgot-password-rate-limit.ts,
// so this follows their exact convention (a small dedicated wrapper over the
// generic lib/rate-limit.ts checkRateLimit, tunable via env, defaulted
// otherwise).
//
// The threshold itself is deliberately more generous than /login's 5/900s:
// a certificate code is ~80 bits of cryptographically random entropy (see
// lib/academies/certificates.ts's generateCertificateCode), so brute-forcing
// a real code by guessing is already computationally infeasible regardless
// of any rate limit reasonable for a public endpoint to enforce — this
// limit exists to bound plain abuse/scraping/DoS volume from a single IP,
// not to be the primary defense against enumeration (the code's entropy is
// that defense). A legitimate visitor might also mistype a printed/PDF code
// a few times, so the threshold errs on the side of not locking out a real
// student over a few typos. 20 attempts / 10 minutes per IP.
const DEFAULT_MAX_ATTEMPTS = 20;
const DEFAULT_WINDOW_SECONDS = 10 * 60;

/**
 * Per-client-IP rate limit for the public `/verify/[certificateCode]` lookup.
 * The `ip` passed in is the first `x-forwarded-for` entry (see the caller,
 * app/verify/[certificateCode]/page.tsx's `getClientIp`) — production
 * deployment assumes a trusted reverse proxy/load balancer sets that header,
 * never a value an untrusted direct caller could spoof to evade this limit.
 */
export async function checkCertificateVerifyRateLimit(ip: string): Promise<RateLimitResult> {
  return checkRateLimit(`verify-certificate:${ip}`, {
    maxAttempts: env.CERTIFICATE_VERIFY_RATE_LIMIT_MAX_ATTEMPTS ?? DEFAULT_MAX_ATTEMPTS,
    windowSeconds:
      env.CERTIFICATE_VERIFY_RATE_LIMIT_WINDOW_SECONDS ?? DEFAULT_WINDOW_SECONDS,
  });
}
