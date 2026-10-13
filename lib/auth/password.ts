import { randomUUID } from "node:crypto";
import argon2, { type HashOptions } from "argon2";
import { z } from "zod";
import { env } from "@/lib/env";

// PLAN.md Cross-Cutting Architecture Decisions: "Password policy: minimum 8
// characters, enforced by a shared Zod schema used everywhere a password is
// set." No forced expiry — there is deliberately no expiry field/check.
export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters");

function argon2Options(): HashOptions & { raw?: false } {
  const options: HashOptions & { raw?: false } = { type: argon2.argon2id };

  if (env.ARGON2_MEMORY_COST) options.memoryCost = env.ARGON2_MEMORY_COST;
  if (env.ARGON2_TIME_COST) options.timeCost = env.ARGON2_TIME_COST;
  if (env.ARGON2_PARALLELISM) options.parallelism = env.ARGON2_PARALLELISM;

  return options;
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, argon2Options());
}

export async function verifyPassword(
  hash: string,
  password: string,
): Promise<boolean> {
  return argon2.verify(hash, password);
}

/**
 * Security audit finding (account enumeration via login timing, CWE-208):
 * `attemptSignIn` (lib/auth/sign-in.ts) must return the identical
 * "Invalid email or password" message whether the email doesn't exist or
 * the password is merely wrong — that part was already correct — but a
 * nonexistent email previously short-circuited before ever calling
 * `verifyPassword`, skipping Argon2id's deliberately expensive hash
 * verification entirely. Measured directly: ~209ms median for a
 * nonexistent email vs. ~325ms median for a wrong password against a real
 * account (the ~115ms gap is Argon2id's own verify cost) — a reliable,
 * network-jitter-proof timing side-channel an attacker can use to learn
 * which emails have accounts, even though the response body/status never
 * differs.
 *
 * Fix: when no user row exists, still pay for one Argon2id verification —
 * against this fixed dummy hash, which never matches any real password —
 * before returning the same generic error, so both paths cost the same.
 * Lazily hashed once per process (not hardcoded) via this module's own
 * `hashPassword()`, so it always uses whatever cost parameters
 * (ARGON2_MEMORY_COST/TIME_COST/PARALLELISM) this environment is actually
 * configured with — a hardcoded hash would drift out of sync with those
 * and silently reopen the timing gap on any environment that tunes them.
 */
let dummyHash: Promise<string> | undefined;

function getDummyHash(): Promise<string> {
  if (!dummyHash) {
    dummyHash = hashPassword(randomUUID());
  }
  return dummyHash;
}

/**
 * Pays for exactly one Argon2id verification without needing a real user
 * row — see `getDummyHash`'s own comment. The result is always `false`
 * (the dummy hash matches no password) and is never meant to be read;
 * callers use this purely for its timing cost on the "no such user" path.
 */
export async function verifyAgainstDummyHash(password: string): Promise<void> {
  await argon2.verify(await getDummyHash(), password);
}
