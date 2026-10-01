import { afterEach, describe, expect, it, vi } from "vitest";
import { nowForDateTimeLocal } from "./students-list";

/**
 * Regression test for the Record Payment dialog's timezone bug (impeccable
 * audit finding, P1): `new Date().toISOString().slice(0, 16)` produces UTC
 * digits, but `<input type="datetime-local">` has no timezone designator
 * and always interprets its value as the user's own LOCAL wall-clock time —
 * so the old default silently showed a time off by the host's UTC offset
 * (3 hours early for this product's own target market, Somalia/UTC+3)
 * unless a staff member noticed and corrected it before submitting a
 * payment. `nowForDateTimeLocal` fixes this by building the string from
 * local time components instead.
 */
describe("nowForDateTimeLocal", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the LOCAL wall-clock time, not the raw UTC digits toISOString() would produce", () => {
    // A fixed instant, independent of whatever timezone this test happens
    // to run in. We compare against the Date object's own LOCAL getters
    // (exactly what a datetime-local input expects), never against
    // toISOString() (UTC) — that comparison is the actual bug this guards
    // against, and it still passes a UTC-timezone test runner by
    // coincidence, which is exactly why it went unnoticed before.
    const fixed = new Date("2026-06-15T10:30:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(fixed);

    const result = nowForDateTimeLocal();

    const pad = (n: number) => String(n).padStart(2, "0");
    const expectedLocal = `${fixed.getFullYear()}-${pad(fixed.getMonth() + 1)}-${pad(fixed.getDate())}T${pad(fixed.getHours())}:${pad(fixed.getMinutes())}`;

    expect(result).toBe(expectedLocal);
  });

  it("produces a value shaped exactly like <input type=\"datetime-local\"> expects (YYYY-MM-DDTHH:mm)", () => {
    const result = nowForDateTimeLocal();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(result).toHaveLength(16);
  });
});
