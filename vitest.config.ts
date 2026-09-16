import { defineConfig } from "vitest/config";

// Vitest runs as a standalone process, so .env.local isn't auto-loaded the
// way Next.js loads it for the app itself (same reasoning as drizzle.config.ts).
try {
  process.loadEnvFile(".env.local");
} catch {
  // .env.local not present (e.g. CI supplies required vars directly).
}

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["node_modules", ".next"],
  },
});
