import type { Page } from "@playwright/test";

/**
 * Drives the real /login form (app/login/page.tsx) exactly as a user
 * would: fills email/password, submits, and waits for the post-login
 * redirect to "/" (lib/auth/actions.ts's signIn — MFA is mandatory for
 * platform_owner only, so an academy-membership-only user like every E2E
 * fixture owner lands directly on "/" with a real session cookie, no MFA
 * detour).
 */
export async function signInViaUI(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/", { timeout: 15_000 });
}
