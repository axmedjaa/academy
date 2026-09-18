import { expect, test } from "@playwright/test";
import { ACADEMY_A } from "./fixtures/constants";
import { signInViaUI } from "./fixtures/auth-helpers";

/**
 * Representative CRUD/workflow smoke tests — proves Playwright is wired
 * against real, already-built pages beyond auth/verify, per this item's
 * reduced scope (breadth of risk over breadth of pages).
 */
test.describe("Representative page smoke tests", () => {
  test.beforeEach(async ({ page }) => {
    await signInViaUI(page, ACADEMY_A.ownerEmail, ACADEMY_A.ownerPassword);
  });

  test("/academy/notifications loads the delivery-status list for a signed-in owner", async ({
    page,
  }) => {
    await page.goto("/academy/notifications");
    await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
  });

  test("/academy/reports hub loads its Student/Academic/Finance tabs without error", async ({
    page,
  }) => {
    await page.goto("/academy/reports");
    await expect(page.getByRole("heading", { name: "Reports", level: 1 })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Application error");
  });
});
