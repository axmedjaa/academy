/**
 * The production migration runner (scripts/migrate.mjs) needs only
 * DATABASE_URL, runs without tsx or .env.local, and never prints the
 * connection password. These tests run it as a child process with a
 * stripped environment. No database is ever reached: the only URL that
 * passes validation points at a closed local port.
 */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function runMigrate(env: Record<string, string>) {
  const result = spawnSync(process.execPath, ["scripts/migrate.mjs"], {
    // Nothing from the developer's environment: no REDIS_URL, no MFA key, no NODE_OPTIONS/tsx.
    env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", ...env } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("scripts/migrate.mjs", () => {
  it("refuses to run without DATABASE_URL", () => {
    const { code, output } = runMigrate({});
    expect(code).toBe(1);
    expect(output).toContain("DATABASE_URL is not set");
  });

  it("refuses a malformed or non-Postgres DATABASE_URL", () => {
    expect(runMigrate({ DATABASE_URL: "not a url" }).output).toContain("not a valid URL");
    const mysql = runMigrate({ DATABASE_URL: "mysql://u:p@localhost/db" });
    expect(mysql.code).toBe(1);
    expect(mysql.output).toContain("must be a postgres");
  });

  it("needs nothing but DATABASE_URL: gets past configuration and only fails on the (unreachable) connection, without printing the password", () => {
    const { code, output } = runMigrate({ DATABASE_URL: "postgres://migrator:TOP-SECRET-PW@127.0.0.1:1/academy" });
    expect(code).toBe(1);
    expect(output).toContain("Running migrations against 127.0.0.1/academy");
    expect(output).toContain("Migration failed");
    // It never asked for application settings.
    expect(output).not.toMatch(/REDIS_URL|MFA_ENCRYPTION_KEY/);
    expect(output).not.toContain("TOP-SECRET-PW");
  });
});
