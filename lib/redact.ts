// Shared redaction rule used by both the structured logger (lib/logger.ts)
// and, later, the audit log's before/after JSON (PLAN.md: "Before/after JSON
// is redacted through the same rule as the structured logger").
//
// Field list per PLAN.md Phase 0 security considerations: password, token,
// password_hash, secret_encrypted, code_hash, cookie values. camelCase
// variants are included since application code uses camelCase; token_hash
// is included alongside password_hash/secret_encrypted/code_hash as the
// same kind of hash-of-a-secret field.
const REDACTED_KEYS = new Set(
  [
    "password",
    "token",
    "password_hash",
    "passwordHash",
    "token_hash",
    "tokenHash",
    "secret_encrypted",
    "secretEncrypted",
    "code_hash",
    "codeHash",
    "cookie",
    "cookies",
  ].map((key) => key.toLowerCase()),
);

const REDACTED_PLACEHOLDER = "[REDACTED]";
const MAX_DEPTH = 10;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep-clones `value`, replacing any value whose key matches a sensitive field name. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth >= MAX_DEPTH || value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (REDACTED_KEYS.has(key.toLowerCase())) {
        result[key] = REDACTED_PLACEHOLDER;
      } else {
        result[key] = redact(val, depth + 1);
      }
    }
    return result;
  }

  return value;
}
