import type { Page } from "@playwright/test";

/**
 * Drives the real /login form (app/login/page.tsx) exactly as a user
 * would: fills email/password, submits, and waits for the post-login
 * redirect. `lib/auth/auth-context.ts`'s `getPostLoginRedirectPath()` —
 * called from both signIn's non-MFA path and challengeMfa's post-
 * verification path — sends platform staff to "/platform/dashboard" and
 * everyone else (every E2E fixture owner, academy-membership-only, no MFA
 * detour) to "/academy/dashboard"; this stopped landing on a blanket "/"
 * some time ago. Stale here until now, which is exactly why e2e had never
 * caught it: the smoke spec's own login still succeeded and the session
 * cookie was real — only this helper's own success condition was wrong,
 * so every spec that calls this helper failed a `waitForURL` that could
 * never be satisfied, independent of anything these specs actually test.
 */
export async function signInViaUI(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/academy/dashboard" || url.pathname === "/platform/dashboard", {
    timeout: 15_000,
  });
}
