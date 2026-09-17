import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required (native Windows PostgreSQL connection string)"),
  REDIS_URL: z
    .string()
    .min(1, "REDIS_URL is required (Memurai connection string, Redis-protocol-compatible)"),
  // Argon2id cost params: optional, tunable via env (PLAN.md Phase 0 security
  // considerations); fall back to argon2's own secure defaults when unset.
  ARGON2_MEMORY_COST: z.coerce.number().int().positive().optional(),
  ARGON2_TIME_COST: z.coerce.number().int().positive().optional(),
  ARGON2_PARALLELISM: z.coerce.number().int().positive().optional(),
  // Session lifetime: PLAN.md never states a value, so this defaults to 30
  // days (fixed TTL, not sliding — nothing in PLAN.md renews a session on
  // activity) and is tunable via env like the Argon2 params above.
  SESSION_DURATION_DAYS: z.coerce.number().int().positive().optional(),
  // Login rate limiting: PLAN.md says "Redis-backed rate limiting on
  // /login" but never states a threshold. Defaults below are a reasonable
  // MVP choice (5 attempts / 15 minutes per client IP), tunable via env.
  LOGIN_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().optional(),
  LOGIN_RATE_LIMIT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .optional(),
  // Password-reset token lifetime: PLAN.md never states a value (only that
  // the token is TTL-bound). Defaults to 60 minutes, tunable via env.
  PASSWORD_RESET_TOKEN_TTL_MINUTES: z.coerce
    .number()
    .int()
    .positive()
    .optional(),
  // /forgot-password rate limiting: same "no threshold specified" gap as
  // /login (line 176 names the endpoint, not a number). Keyed by the
  // requested email rather than IP (see lib/auth/password-reset.ts) since
  // the actual abuse case here is flooding one victim's inbox, which an
  // IP-based limit wouldn't stop.
  FORGOT_PASSWORD_RATE_LIMIT_MAX_ATTEMPTS: z.coerce
    .number()
    .int()
    .positive()
    .optional(),
  FORGOT_PASSWORD_RATE_LIMIT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .optional(),
  // MFA TOTP secret encryption key: PLAN.md requires this be "separate
  // from password hashing" and app-level, via env. Required (never
  // defaulted — a default encryption key would defeat its purpose).
  // 32 raw bytes, base64-encoded (AES-256-GCM).
  MFA_ENCRYPTION_KEY: z
    .string()
    .min(1, "MFA_ENCRYPTION_KEY is required (32-byte base64 AES-256 key)")
    .refine(
      (value) => Buffer.from(value, "base64").length === 32,
      "MFA_ENCRYPTION_KEY must decode to exactly 32 bytes",
    ),
  // /mfa/challenge rate limiting: same "endpoint named, no threshold given"
  // gap as /login and /forgot-password.
  MFA_CHALLENGE_RATE_LIMIT_MAX_ATTEMPTS: z.coerce
    .number()
    .int()
    .positive()
    .optional(),
  MFA_CHALLENGE_RATE_LIMIT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .optional(),
  // Public /verify/[certificateCode] rate limiting (PLAN.md Phase 5, Item
  // 62: "rate-limited [per IP] and logged" — no threshold given). See
  // lib/academies/certificate-verify-rate-limit.ts for the default/rationale.
  CERTIFICATE_VERIFY_RATE_LIMIT_MAX_ATTEMPTS: z.coerce
    .number()
    .int()
    .positive()
    .optional(),
  CERTIFICATE_VERIFY_RATE_LIMIT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .optional(),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid or missing environment variables:\n${issues}\n\nCheck .env.local against .env.example.`,
    );
  }

  return result.data;
}

export const env = loadEnv();
