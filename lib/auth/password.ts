import argon2, { type HashOptions } from "argon2";
import { z } from "zod";
import { env } from "@/lib/env";

// PLAN.md Cross-Cutting Architecture Decisions: "Password policy: minimum 12
// characters, enforced by a shared Zod schema used everywhere a password is
// set." No forced expiry — there is deliberately no expiry field/check.
export const passwordSchema = z
  .string()
  .min(12, "Password must be at least 12 characters");

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
