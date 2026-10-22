import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated / vendored output, never hand-written source:
    // Playwright's separate Next build dir (E2E_DIST_DIR in
    // playwright.config.ts) and the vendored design-system bundle.
    ".next-e2e/**",
    "ds-bundle/**",
  ]),
]);

export default eslintConfig;
