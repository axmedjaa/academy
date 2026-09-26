import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getAcademyLogoKey, isAcademyLogoKey } from "./keys";

const ACADEMY_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ACADEMY_ID = "22222222-2222-2222-2222-222222222222";

describe("getAcademyLogoKey", () => {
  it("builds a key under academies/{academyId}/logos/ with a UUID filename", () => {
    const key = getAcademyLogoKey({ academyId: ACADEMY_ID, extension: "png" });
    expect(key).toMatch(
      new RegExp(`^academies/${ACADEMY_ID}/logos/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.png$`),
    );
  });

  it("never reuses the same key twice", () => {
    const a = getAcademyLogoKey({ academyId: ACADEMY_ID, extension: "png" });
    const b = getAcademyLogoKey({ academyId: ACADEMY_ID, extension: "png" });
    expect(a).not.toBe(b);
  });
});

describe("isAcademyLogoKey", () => {
  it("accepts a key this module itself generated for the same academy", () => {
    const key = getAcademyLogoKey({ academyId: ACADEMY_ID, extension: "webp" });
    expect(isAcademyLogoKey(key, ACADEMY_ID)).toBe(true);
  });

  it("rejects a key generated for a different academy", () => {
    const key = getAcademyLogoKey({ academyId: OTHER_ACADEMY_ID, extension: "png" });
    expect(isAcademyLogoKey(key, ACADEMY_ID)).toBe(false);
  });

  it("rejects path traversal smuggled after a legitimate-looking prefix", () => {
    expect(isAcademyLogoKey(`academies/${ACADEMY_ID}/logos/../../../etc/passwd`, ACADEMY_ID)).toBe(false);
    expect(isAcademyLogoKey(`academies/${ACADEMY_ID}/logos/../${OTHER_ACADEMY_ID}/logos/x.png`, ACADEMY_ID)).toBe(
      false,
    );
  });

  it("rejects a nested extra path segment after the uuid filename", () => {
    expect(isAcademyLogoKey(`academies/${ACADEMY_ID}/logos/${randomUUID()}.png/extra`, ACADEMY_ID)).toBe(false);
  });

  it("rejects a non-uuid filename", () => {
    expect(isAcademyLogoKey(`academies/${ACADEMY_ID}/logos/not-a-uuid.png`, ACADEMY_ID)).toBe(false);
  });

  it("rejects an arbitrary unrelated key", () => {
    expect(isAcademyLogoKey("some/other/key.png", ACADEMY_ID)).toBe(false);
  });
});
