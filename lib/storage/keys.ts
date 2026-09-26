import { randomUUID } from "node:crypto";

/**
 * Centralizes object-key construction so no other file scatters string
 * concatenation like `academies/${academyId}/logos/...` — this is the one
 * place that convention lives. Every key is namespaced under the
 * server-resolved `academyId` (never client-supplied — see the caller's own
 * doc comment, e.g. lib/academies/academy-logo.ts) and uses a fresh random
 * UUID as the filename, never the original filename or anything else a
 * client provided, so a key can never encode a path-traversal segment, a
 * user's name/email, or another academy's id.
 *
 * Only the logo entity is implemented in this task. Future entities will
 * add their own `getXKey`/`isXKey` pair here (students, staff, id-cards,
 * payment evidence — see this file's own future-prefixes note below) rather
 * than each reinventing key construction.
 */

const ACADEMY_LOGO_SEGMENT = "logos";

// Future entities (NOT implemented in this task — see lib/academies/academy-logo.ts's
// own module comment for the current task's scope): students, staff,
// id-cards, payment-evidence would each get their own `academies/{academyId}/{segment}/...`
// prefix here, following this exact same shape.

export interface AcademyLogoKeyInput {
  academyId: string;
  /** Server-derived from an allowlisted content-type map (see
   * ALLOWED_LOGO_CONTENT_TYPES in academy-logo.ts) — never the client's
   * original filename/extension. */
  extension: string;
}

export function getAcademyLogoKey({ academyId, extension }: AcademyLogoKeyInput): string {
  return `academies/${academyId}/${ACADEMY_LOGO_SEGMENT}/${randomUUID()}.${extension}`;
}

const UUID_FILENAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/i;

/**
 * The one gate every academy-logo confirm/remove/delete path must pass a
 * key through before trusting it belongs to this academy — never just a
 * string-prefix check. Requires the remainder after the expected
 * `academies/{academyId}/logos/` prefix to be EXACTLY `<uuid>.<ext>`, with
 * no further `/` segments — this is what actually rules out `../../` or a
 * smuggled nested path riding along after a legitimate-looking prefix.
 */
export function isAcademyLogoKey(key: string, academyId: string): boolean {
  const expectedPrefix = `academies/${academyId}/${ACADEMY_LOGO_SEGMENT}/`;
  if (!key.startsWith(expectedPrefix)) {
    return false;
  }
  const rest = key.slice(expectedPrefix.length);
  return UUID_FILENAME_PATTERN.test(rest);
}
