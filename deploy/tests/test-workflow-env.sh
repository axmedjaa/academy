#!/usr/bin/env bash
# Runs the exact "Build deployment bundle" script from .github/workflows/ci.yml
# against fake APP_ENV / TRUSTED_PROXY_HOP_COUNT values and checks the app.env
# it packs, its permissions, and that no secret value is ever printed.
#   bash deploy/tests/test-workflow-env.sh      (needs node + the repo's js-yaml)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../.." && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
PASS=0; FAIL=0
STEP="$WORK/step.sh"
(cd "$REPO" && node -e '
  const yaml = require("js-yaml"), fs = require("fs");
  const wf = yaml.load(fs.readFileSync(".github/workflows/ci.yml", "utf8"));
  const step = wf.jobs.deploy.steps.find((s) => s.name === "Build deployment bundle");
  const env = step.env;
  if (env.APP_ENV !== "${{ secrets.APP_ENV }}" || env.TRUSTED_PROXY_HOP_COUNT !== "${{ secrets.TRUSTED_PROXY_HOP_COUNT }}") process.exit(2);
  fs.writeFileSync(process.argv[1], step.run);' "$STEP") || { echo "could not extract the step"; exit 1; }

SECRET_DB='postgresql://fake-user:not-a-real-password@db.invalid/fake?sslmode=require'
SECRET_KEY='bm90LWEtcmVhbC1rZXktbm90LWEtcmVhbC1rZXktMTI='
BASE_ENV="DATABASE_URL=$SECRET_DB
REDIS_URL=redis://127.0.0.1:6379
MFA_ENCRYPTION_KEY=$SECRET_KEY
APP_URL=http://2.24.58.228
# comment kept
R2_SECRET_ACCESS_KEY=not-a-real-r2-secret"

run() {  # $1 label, $2 APP_ENV, $3 TRUSTED_PROXY_HOP_COUNT secret, $4 expect ok|fail, [$5 expected error]
  local d="$WORK/case"; rm -rf "$d"; mkdir -p "$d/release"; echo x > "$d/release/release.tar.gz"
  OUT="$(cd "$d" && APP_ENV="$2" TRUSTED_PROXY_HOP_COUNT="$3" RUNNER_TEMP="$d" bash -eo pipefail "$STEP" 2>&1)"; RC=$?
  ENVF="$d/x/app.env"; rm -rf "$d/x"; mkdir "$d/x"
  [ -f "$d/deploy-bundle.tar" ] && tar -xpf "$d/deploy-bundle.tar" -C "$d/x" 2>/dev/null
  local ok=1
  if [ "$4" = ok ]; then [ "$RC" = 0 ] || ok=0; else [ "$RC" != 0 ] || ok=0; fi
  if [ -n "${5:-}" ] && ! grep -qF -- "$5" <<<"$OUT"; then ok=0; fi
  for s in not-a-real-password "$SECRET_KEY" not-a-real-r2-secret; do grep -qF -- "$s" <<<"$OUT" && { ok=0; echo "      LEAK: a secret value was printed"; }; done
  if [ "$ok" = 1 ]; then PASS=$((PASS + 1)); printf '    ok    %s\n' "$1"
  else FAIL=$((FAIL + 1)); printf '    FAIL  %s (exit %s)\n' "$1" "$RC"; sed 's/^/          | /' <<<"$OUT" | tail -5; fi
}
expect() {  # $1 label, $2 condition
  if eval "$2"; then PASS=$((PASS + 1)); printf '    ok    %s\n' "$1"; else FAIL=$((FAIL + 1)); printf '    FAIL  %s\n' "$1"; fi
}
others() { grep -Ev '^TRUSTED_PROXY_HOP_COUNT=' "$1"; }

echo "### accepted"
run "APP_ENV has TRUSTED_PROXY_HOP_COUNT=1, no separate secret" "$BASE_ENV
TRUSTED_PROXY_HOP_COUNT=1" "" ok "using the value in APP_ENV"
expect "  app.env == APP_ENV" '[ "$(cat "$ENVF")" = "$BASE_ENV
TRUSTED_PROXY_HOP_COUNT=1" ]'

run "APP_ENV lacks it, secret = 1 (today's setup)" "$BASE_ENV" "1" ok "taken from its own secret"
expect "  exactly one TRUSTED_PROXY_HOP_COUNT=1" '[ "$(grep -c "^TRUSTED_PROXY_HOP_COUNT=" "$ENVF")" = 1 ] && grep -qx "TRUSTED_PROXY_HOP_COUNT=1" "$ENVF"'
expect "  every other APP_ENV line kept unchanged" '[ "$(others "$ENVF")" = "$BASE_ENV" ]'
expect "  bundle holds exactly app.env + release.tar.gz" '[ "$(ls "$WORK/case/x" | sort | tr "\n" " ")" = "app.env release.tar.gz " ]'
[ "$(uname -s | cut -c1-5)" != MINGW ] && expect "  app.env packed with mode 600" '[ "$(stat -c %a "$ENVF")" = 600 ]'
expect "  only variable names are logged" 'grep -q "names only): APP_URL DATABASE_URL MFA_ENCRYPTION_KEY R2_SECRET_ACCESS_KEY REDIS_URL TRUSTED_PROXY_HOP_COUNT" <<<"$OUT"'
expect "  no plain app.env left on the runner" '[ ! -e "$WORK/case/deploy-bundle/app.env" ]'

run "secret overrides a different value in APP_ENV" "$BASE_ENV
TRUSTED_PROXY_HOP_COUNT=2" "1" ok
expect "  replaced, not duplicated" '[ "$(grep -c "^TRUSTED_PROXY_HOP_COUNT=" "$ENVF")" = 1 ] && grep -qx "TRUSTED_PROXY_HOP_COUNT=1" "$ENVF"'
expect "  every other APP_ENV line kept unchanged" '[ "$(others "$ENVF")" = "$BASE_ENV" ]'

run "quoted value in APP_ENV" "$BASE_ENV
TRUSTED_PROXY_HOP_COUNT=\"1\"" "" ok

echo "### rejected"
run "missing everywhere" "$BASE_ENV" "" fail "missing a value for: TRUSTED_PROXY_HOP_COUNT"
run "secret is 0" "$BASE_ENV" "0" fail "TRUSTED_PROXY_HOP_COUNT secret must be a whole number of at least 1"
run "secret is not a number" "$BASE_ENV" "one" fail "TRUSTED_PROXY_HOP_COUNT secret must be a whole number of at least 1"
run "APP_ENV value 0, no secret" "$BASE_ENV
TRUSTED_PROXY_HOP_COUNT=0" "" fail "must be a whole number of at least 1"
run "APP_ENV value empty, no secret" "$BASE_ENV
TRUSTED_PROXY_HOP_COUNT=" "" fail "missing a value for: TRUSTED_PROXY_HOP_COUNT"
run "duplicated in APP_ENV, no secret" "$BASE_ENV
TRUSTED_PROXY_HOP_COUNT=1
TRUSTED_PROXY_HOP_COUNT=3" "" fail "must appear exactly once"
run "missing DATABASE_URL" "$(grep -v '^DATABASE_URL' <<<"$BASE_ENV")" "1" fail "missing a value for: DATABASE_URL"
run "missing REDIS_URL and MFA_ENCRYPTION_KEY" "$(grep -Ev '^(REDIS_URL|MFA_ENCRYPTION_KEY)' <<<"$BASE_ENV")" "1" fail "missing a value for: REDIS_URL MFA_ENCRYPTION_KEY"
run "export lines" "export DATABASE_URL=$SECRET_DB
REDIS_URL=redis://127.0.0.1:6379" "1" fail "without 'export'"
run "Windows line endings" "$(printf 'DATABASE_URL=%s\r\nREDIS_URL=x\r\n' "$SECRET_DB")" "1" fail "Windows line endings"
run "empty APP_ENV" "  " "1" fail "APP_ENV secret is empty"

echo; echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
