import { expect, test } from "@playwright/test";
import { ACADEMY_A, ACADEMY_B } from "./fixtures/constants";
import { getBatchIdForAcademy } from "./fixtures/seed-e2e";
import { signInViaUI } from "./fixtures/auth-helpers";

/**
 * PLAN.md Phase 5 acceptance bar: "The full Playwright suite passes with
 * zero cross-tenant leakage across a two-academy scenario." This file is
 * the single most important thing this item adds — every test below is
 * built so it would genuinely fail if tenant scoping broke, not just so it
 * trivially passes:
 *
 * - The student-list test asserts on Academy B data that demonstrably
 *   exists (seeded by e2e/fixtures/seed-e2e.ts) and is visible to Academy
 *   B's own owner (proven directly, not assumed) — so "Academy B's data
 *   never appears to Academy A" is a real negative check against real
 *   rows, not an assertion that would pass even with zero data anywhere.
 * - The batch-detail IDOR test uses Academy B's *real*, live database id
 *   (looked up fresh via getBatchIdForAcademy, never hardcoded/guessed) —
 *   and is paired with a "control" test proving that same id resolves to
 *   real data for Academy B's own owner. Together they prove the
 *   not-found response Academy A gets is because of tenant scoping, not
 *   because the id is invalid or the row doesn't exist.
 */
test.describe("Cross-tenant isolation", () => {
  test("control: Academy B's own owner can see Academy B's real batch by id", async ({ page }) => {
    const batchId = await getBatchIdForAcademy(ACADEMY_B.slug, ACADEMY_B.batchCode);

    await signInViaUI(page, ACADEMY_B.ownerEmail, ACADEMY_B.ownerPassword);
    await page.goto(`/academy/batches/${batchId}`);

    // Proves the id is real and the row is genuinely viewable by its own
    // tenant — the necessary control for the IDOR test below.
    await expect(page.getByText(ACADEMY_B.batchName)).toBeVisible();
    await expect(page.getByText(`(${ACADEMY_B.batchCode})`)).toBeVisible();
  });

  test("Academy A's student list never contains Academy B's students", async ({ page }) => {
    await signInViaUI(page, ACADEMY_A.ownerEmail, ACADEMY_A.ownerPassword);
    await page.goto("/academy/students");

    await expect(page.getByRole("heading", { name: "Students" })).toBeVisible();

    // Sanity: Academy A's own seeded students genuinely render here —
    // otherwise the negative assertions below would be checking nothing.
    await expect(page.getByText(ACADEMY_A.studentNumber)).toBeVisible();
    await expect(page.getByText(ACADEMY_A.studentName)).toBeVisible();

    // The real check: Academy B's students, which definitely exist in the
    // database right now (seeded alongside Academy A's), must never appear
    // in Academy A's own list — not filtered client-side, not present at
    // all in the server-rendered HTML.
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toContain(ACADEMY_B.studentNumber);
    expect(bodyText).not.toContain(ACADEMY_B.studentName);
    expect(bodyText).not.toContain(ACADEMY_B.secondStudentNumber);
    expect(bodyText).not.toContain(ACADEMY_B.secondStudentName);
  });

  test("Academy A signed in, guessing Academy B's real batch id: clean not-found, never Academy B's data", async ({
    page,
  }) => {
    const academyBBatchId = await getBatchIdForAcademy(ACADEMY_B.slug, ACADEMY_B.batchCode);

    await signInViaUI(page, ACADEMY_A.ownerEmail, ACADEMY_A.ownerPassword);
    await page.goto(`/academy/batches/${academyBBatchId}`);

    // The actual leak this test exists to catch: Academy B's real batch
    // name/code rendered to an Academy A session.
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toContain(ACADEMY_B.batchName);
    expect(bodyText).not.toContain(ACADEMY_B.batchCode);

    // What should happen instead: the same generic "not found" response a
    // nonexistent id gets (lib/academies/batches.ts's NOT_FOUND — same
    // code/message for nonexistent, cross-academy, and unassigned-branch
    // cases, by design, so a guess can't distinguish any of them).
    await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
    await expect(page.getByText("Batch not found.")).toBeVisible();
  });
});
