import { defineConfig } from "drizzle-kit";

// drizzle-kit runs as a standalone CLI process, so .env.local isn't
// auto-loaded the way Next.js loads it for the app itself.
try {
  process.loadEnvFile(".env.local");
} catch {
  // .env.local not present (e.g. CI supplies DATABASE_URL directly).
}

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required to run Drizzle Kit. Check .env.local against .env.example.",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
