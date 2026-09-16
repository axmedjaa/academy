import { eq } from "drizzle-orm";
import * as OTPAuth from "otpauth";
import { db } from "@/lib/db";
import { users, platformMemberships } from "@/lib/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { enrollMfaForUser, verifyMfaEnrollmentForUser } from "@/lib/auth/mfa";

// PLAN.md "Seed & Demonstration Data": guarded, refuses to run in
// production. This is the Phase 0 seed — just the one MFA-enrolled
// platform_owner; the full demo dataset (academy, branches, students...)
// is a later-phase concern once those tables exist.
if (process.env.NODE_ENV === "production") {
  console.error("Refusing to run: seed script must not run in production.");
  process.exit(1);
}

// Demo credentials live only here (env-overridable) and in
// .env.example/README — never hardcoded as if they were real secrets.
const email = (
  process.env.SEED_PLATFORM_OWNER_EMAIL ?? "owner@example.com"
).toLowerCase();
const password =
  process.env.SEED_PLATFORM_OWNER_PASSWORD ?? "changeme-12345678";

async function main() {
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing) {
    console.log(`Seed platform_owner already exists (${email}) — skipping.`);
    return;
  }

  const passwordHash = await hashPassword(password);
  const [user] = await db
    .insert(users)
    .values({ email, passwordHash })
    .returning({ id: users.id });

  await db
    .insert(platformMemberships)
    .values({ userId: user.id, role: "platform_owner" });

  // Drive the real enrollment flow (Item 13) rather than inserting a
  // pre-verified credential row directly, so the seeded account is
  // guaranteed consistent with what a real enrollment produces.
  const { secretBase32 } = await enrollMfaForUser(user.id);
  const currentCode = new OTPAuth.TOTP({
    issuer: "Academy Management SaaS",
    label: email,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: secretBase32,
  }).generate();

  const verifyResult = await verifyMfaEnrollmentForUser(user.id, currentCode);
  if (!verifyResult.ok) {
    throw new Error(
      `Seed MFA verification unexpectedly failed: ${verifyResult.error.message}`,
    );
  }

  console.log("Seeded platform_owner:");
  console.log(`  Email:    ${email}`);
  console.log(`  Password: ${password}`);
  console.log(`  TOTP secret (add to an authenticator app): ${secretBase32}`);
  console.log("  Recovery codes (shown once, save them):");
  for (const code of verifyResult.recoveryCodes) {
    console.log(`    ${code}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exit(1);
  });
