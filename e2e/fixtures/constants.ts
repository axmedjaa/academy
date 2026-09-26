/**
 * PLAN.md Phase 5, Item 65 — full Playwright coverage.
 *
 * Fixed, well-known identifiers for the two demo academies the E2E suite
 * needs for the "zero cross-tenant leakage across a two-academy scenario"
 * acceptance bar. Every value here is either a stable non-secret slug/code
 * (safe to hardcode — it's test-fixture data, not a credential) or an
 * env-overridable credential with a sane test-only default, following the
 * same convention .env.example already uses for
 * SEED_PLATFORM_OWNER_EMAIL/PASSWORD (scripts/seed.ts).
 *
 * Never a real secret: these are throwaway accounts created by
 * e2e/fixtures/seed-e2e.ts against a local/CI Postgres instance only —
 * scripts/seed.ts's guard against NODE_ENV=production is mirrored there.
 */

// passwordSchema (lib/auth/password.ts) requires >=8 characters — this
// default clears that bar comfortably.
const DEFAULT_E2E_PASSWORD = "E2eTestPassw0rd!";

export interface E2EAcademyFixture {
  slug: string;
  name: string;
  ownerEmail: string;
  ownerPassword: string;
  branchCode: string;
  branchName: string;
  programName: string;
  courseName: string;
  batchCode: string;
  batchName: string;
  studentNumber: string;
  studentName: string;
  secondStudentNumber: string;
  secondStudentName: string;
  certificateCode: string;
}

export const ACADEMY_A: E2EAcademyFixture = {
  slug: "e2e-academy-a",
  name: "E2E Academy A",
  ownerEmail: (
    process.env.E2E_ACADEMY_A_OWNER_EMAIL ?? "e2e-academy-a-owner@example.com"
  ).toLowerCase(),
  ownerPassword: process.env.E2E_ACADEMY_A_OWNER_PASSWORD ?? DEFAULT_E2E_PASSWORD,
  branchCode: "MAIN",
  branchName: "Main Branch",
  programName: "E2E Program A",
  courseName: "E2E Course A",
  batchCode: "BATCH-E2E-A",
  batchName: "E2E Batch A",
  studentNumber: "STD-E2E-A-001",
  studentName: "Alpha Anderson",
  secondStudentNumber: "STD-E2E-A-002",
  secondStudentName: "Aiden Adeyemi",
  certificateCode: "E2E-CERT-VALID-A",
};

export const ACADEMY_B: E2EAcademyFixture = {
  slug: "e2e-academy-b",
  name: "E2E Academy B",
  ownerEmail: (
    process.env.E2E_ACADEMY_B_OWNER_EMAIL ?? "e2e-academy-b-owner@example.com"
  ).toLowerCase(),
  ownerPassword: process.env.E2E_ACADEMY_B_OWNER_PASSWORD ?? DEFAULT_E2E_PASSWORD,
  branchCode: "MAIN",
  branchName: "Main Branch",
  programName: "E2E Program B",
  courseName: "E2E Course B",
  batchCode: "BATCH-E2E-B",
  batchName: "E2E Batch B",
  studentNumber: "STD-E2E-B-001",
  studentName: "Bravo Baxter",
  secondStudentNumber: "STD-E2E-B-002",
  secondStudentName: "Blessing Bello",
  certificateCode: "E2E-CERT-VALID-B",
};

export const E2E_PLAN_NAME = "E2E Playwright Test Plan";
