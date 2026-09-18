import { expect, test } from "@playwright/test";
import { ACADEMY_A } from "./fixtures/constants";

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

test.describe("Public certificate verification (/verify/[certificateCode])", () => {
  test("a valid code shows certificate details, unauthenticated", async ({ page }) => {
    await page.goto(`/verify/${ACADEMY_A.certificateCode}`);

    await expect(page.getByRole("heading", { name: "Certificate Verification" })).toBeVisible();
    await expect(page.getByText("Valid", { exact: true })).toBeVisible();
    await expect(page.getByText(ACADEMY_A.studentName)).toBeVisible();
    await expect(page.getByText(ACADEMY_A.programName)).toBeVisible();

    // No app chrome/navigation on this public route (DESIGN.md §10) — in
    // particular, no session-gated sign-in/out affordance from a shared
    // layout leaking through.
    await expect(page.getByRole("link", { name: "Sign in" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);

    // Real-browser confirmation of what Wave 1's Vitest tests already
    // assert at the data layer (verifyCertificate's VerifyCertificateResult
    // type only ever exposes studentName/programName/issuedAt/status): the
    // rendered page never leaks a raw internal id (certificate/student/
    // batch/academy uuid) anywhere in its text.
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toMatch(UUID_PATTERN);
  });

  test("an invalid code shows a generic not-found message, never a leak", async ({ page }) => {
    const bogusCode = `does-not-exist-${Date.now()}`;
    await page.goto(`/verify/${bogusCode}`);

    await expect(page.getByRole("heading", { name: "Certificate Verification" })).toBeVisible();
    await expect(
      page.getByText(/no certificate was found for this code/i),
    ).toBeVisible();

    // Never renders the Valid/Cancelled status UI for a code that doesn't
    // resolve to anything.
    await expect(page.getByText("Valid", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Cancelled", { exact: true })).toHaveCount(0);
  });
});
