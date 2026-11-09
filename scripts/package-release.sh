#!/usr/bin/env bash
# Packages the production build into release/release.tar.gz plus
# release/release.sha256, for a manual deploy (copy to the server, verify
# the checksum, extract, start).
#
# Run from the repository root AFTER `npm run build`, `npm run build:worker`
# and `npm prune --omit=dev` (so node_modules holds production dependencies
# only). CI does exactly that as its final steps.
#
# The archive has no top-level folder: extract it into an empty release
# directory and start the app from there with
#   node node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3000
#
# This project does not use `output: "standalone"`, so `next start` needs
# the full .next build, the production node_modules, package.json and
# next.config.ts (plus lib/http/security-headers.ts, which the config
# imports). No .env file is ever included: configuration comes from the
# server's environment.
set -euo pipefail

OUT_DIR="release"
STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT

fail() {
  echo "package-release: $*" >&2
  exit 1
}

# The build and the worker bundle must already exist.
[ -f .next/BUILD_ID ] || fail ".next/BUILD_ID not found; run npm run build first."
[ -f dist/worker.mjs ] || fail "dist/worker.mjs not found; run npm run build:worker first."
[ -x node_modules/.bin/next ] || [ -f node_modules/next/dist/bin/next ] || fail "node_modules/next is missing."
# Refuse to ship dev tooling: prune must have run.
[ ! -d node_modules/vitest ] || fail "dev dependencies are still installed; run npm prune --omit=dev first."

# Runtime files, relative to the repository root.
FILES=(
  .next
  node_modules
  public
  package.json
  package-lock.json
  next.config.ts
  lib/http/security-headers.ts
  dist/worker.mjs
  dist/worker.mjs.map
  scripts/migrate.mjs
  drizzle
)

for f in "${FILES[@]}"; do
  [ -e "$f" ] || fail "missing $f"
done

# Copy into a staging folder so exclusions are explicit.
tar -cf - \
  --exclude='.next/cache' \
  --exclude='.next/dev' \
  --exclude='node_modules/.cache' \
  "${FILES[@]}" | tar -xf - -C "$STAGE_DIR"

# Next writes to these at runtime, but neither exists after a build
# (.next/cache is excluded above, route-cache is created on first request).
# Shipping them empty lets the server's permission setup (chown/chmod,
# systemd ReadWritePaths=) target them straight after extraction.
mkdir -p "$STAGE_DIR/.next/cache" "$STAGE_DIR/.next/server/route-cache"

# Every symlink must survive the move to another machine: relative, pointing
# inside the release, and not broken. On Linux, Next can create links such as
# .next/node_modules/<pkg>-<hash>; an absolute CI path there would only fail
# on the server, at the first request that loads that package.
STAGE_REAL="$(realpath "$STAGE_DIR")"
BAD_LINKS=""
while IFS= read -r -d '' link; do
  target="$(readlink "$link")"
  resolved="$(realpath -m "$(dirname "$link")/$target")"
  if [[ "$target" == /* ]] || [[ "$resolved" != "$STAGE_REAL"/* ]] || [ ! -e "$link" ]; then
    BAD_LINKS+="${link#"$STAGE_DIR"/} -> $target"$'\n'
  fi
done < <(find "$STAGE_DIR" -type l -print0)
[ -z "$BAD_LINKS" ] || fail "symlinks that would break after extraction:
$BAD_LINKS"

# Safety net: no environment files, keys or certificates anywhere outside
# third-party packages.
LEAKS="$(find "$STAGE_DIR" -path "$STAGE_DIR/node_modules" -prune -o \
  \( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' -o -name 'id_rsa*' \) -print)"
[ -z "$LEAKS" ] || fail "refusing to package secret-looking files:
$LEAKS"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

tar -czf "$OUT_DIR/release.tar.gz" -C "$STAGE_DIR" .
(cd "$OUT_DIR" && sha256sum release.tar.gz > release.sha256 && sha256sum -c release.sha256)

ls -l "$OUT_DIR"
