import { expect, test } from "@playwright/test";
import { ACADEMY_A } from "./fixtures/constants";

test.describe("Auth flow", () => {
  test("valid credentials sign in and land on a signed-in page", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(ACADEMY_A.ownerEmail);
    await page.getByLabel("Password").fill(ACADEMY_A.ownerPassword);
    await page.getByRole("button", { name: "Sign in" }).click();

    await page.waitForURL((url) => url.pathname === "/");
    await expect(page.getByText(`Signed in as ${ACADEMY_A.ownerEmail}.`)).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  });

  test("invalid credentials show an error and grant no session", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(ACADEMY_A.ownerEmail);
    await page.getByLabel("Password").fill("definitely-the-wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByRole("alert")).toBeVisible();
    // Still on /login — no redirect to a signed-in page happened.
    await expect(page).toHaveURL(/\/login$/);

    const cookies = await page.context().cookies();
    expect(cookies.some((c) => c.name === "session")).toBe(false);

    // A follow-up direct navigation to an authenticated route confirms no
    // access was granted, not just that the redirect didn't happen.
    await page.goto("/academy/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });
});
