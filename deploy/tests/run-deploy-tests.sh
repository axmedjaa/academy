#!/usr/bin/env bash
# End-to-end tests for deploy/myapp-deploy with stand-ins for systemctl and
# sudo, a stub app on 127.0.0.1:3999 serving /api/health, and the real
# deploy/myapp-safe-extract. Never touches /srv, systemd or a real service.
#
#   bash deploy/tests/run-deploy-tests.sh          (Linux, or Git Bash on Windows)
#
# Needs bash, node, python3 (3.12+), curl, GNU tar/find/coreutils.
# On Git Bash only: flock is replaced by a stand-in, and because Git Bash
# cannot rename its emulated symlinks, the test copy writes "current"
# directly instead of the atomic ln + mv -T swap.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(cd "$HERE/.." && pwd)"
BASE="$HERE/run"; GEN="$BASE/bin"; rm -rf "$BASE"; mkdir -p "$GEN"
PASS=0; FAIL=0; PAT=""
MSYS_HOST=0; case "$(uname -s)" in MINGW*|MSYS*) MSYS_HOST=1; export MSYS=winsymlinks:lnk ;; esac

REAL_LN="$(command -v ln)"; REAL_INSTALL="$(command -v install)"
cat > "$GEN/sudo" <<'EOF'
#!/usr/bin/env bash
[ "$1" = -n ] && shift; exec "$@"
EOF
# Failure injection: FAIL_SWITCH_TO=<release> makes linking to it fail,
# FAIL_ENV_INSTALL=1 makes staging app.env fail.
cat > "$GEN/ln" <<EOF
#!/usr/bin/env bash
if [ -n "\${FAIL_SWITCH_TO:-}" ] && [[ " \$* " == *"releases/\$FAIL_SWITCH_TO "* ]]; then echo "stub: ln failed" >&2; exit 1; fi
exec "$REAL_LN" "\$@"
EOF
cat > "$GEN/install" <<EOF
#!/usr/bin/env bash
if [ "\${FAIL_ENV_INSTALL:-}" = 1 ]; then echo "stub: install failed" >&2; exit 1; fi
exec "$REAL_INSTALL" "\$@"
EOF
if [ "$MSYS_HOST" = 1 ]; then
  cat > "$GEN/flock" <<'EOF'
#!/usr/bin/env bash
# Stand-in for util-linux flock -n (missing on Git Bash): "held" while a marker exists.
[ -e "$DEPLOY_TEST_ROOT/lock.held" ] && exit 1; exit 0
EOF
  EXTRACT_CMD="python -I \"\$(cygpath -w \"$DEPLOY_DIR/myapp-safe-extract\")\" \"\$1\" \"\$(cygpath -w \"\$2\")\" \"\$(cygpath -w \"\$3\")\""
else
  rm -f "$GEN/flock"
  EXTRACT_CMD="python3 -I \"$DEPLOY_DIR/myapp-safe-extract\" \"\$@\""
fi
# PAUSE_EXTRACT=<seconds> (test only): announce "extraction started" with a
# marker file and pause, so a signal can be delivered while the deployment is
# provably still before any production change.
cat > "$GEN/safe-extract" <<EOF
#!/usr/bin/env bash
if [ -n "\${PAUSE_EXTRACT:-}" ]; then touch "\$DEPLOY_TEST_ROOT/state/extract-started"; sleep "\$PAUSE_EXTRACT"; fi
exec $EXTRACT_CMD
EOF
chmod +x "$GEN/"* "$HERE/bin/systemctl"
export PATH="$GEN:$HERE/bin:$PATH"

# The script under test: identical apart from configuration constants (and,
# on Git Bash only, the symlink swap).
make_script() {  # $1 root, $2 out, [$3 max bundle bytes], [$4 health timeout]
  local msys_patch=()
  [ "$MSYS_HOST" = 1 ] && msys_patch=(-e 's|^    && mv -fT -- "\$APP_ROOT/.current.new" "\$CURRENT_LINK"$|    \&\& rm -f -- "$APP_ROOT/.current.new" "$CURRENT_LINK" \&\& ln -s -- "$link" "$CURRENT_LINK"  # TEST ONLY (Git Bash)|')
  sed -e "s#^APP_ROOT=.*#APP_ROOT=\"$1\"#" \
      -e "s#^APP_GROUP=.*#APP_GROUP=$(id -g)#" \
      -e "s#^MAX_BUNDLE_BYTES=.*#MAX_BUNDLE_BYTES=${3:-\$((620 * 1024 * 1024))}#" \
      -e "s#^HEALTH_URL=.*#HEALTH_URL=http://127.0.0.1:3999/api/health#" \
      -e "s#^HEALTH_TIMEOUT_SECONDS=.*#HEALTH_TIMEOUT_SECONDS=${4:-8}#" \
      -e "s#^HEALTH_RETRY_SECONDS=.*#HEALTH_RETRY_SECONDS=1#" \
      -e "s#^WORKER_SETTLE_SECONDS=.*#WORKER_SETTLE_SECONDS=1#" \
      -e "s#^WORKER_STABLE_SECONDS=.*#WORKER_STABLE_SECONDS=2#" \
      -e "s#^SAFE_EXTRACT=.*#SAFE_EXTRACT=$GEN/safe-extract#" \
      -e "s#^NODE=.*#NODE=node#" \
      -e "s#^SYSTEMCTL=.*#SYSTEMCTL=$HERE/bin/systemctl#" \
      -e "s#^SUDO=.*#SUDO=$GEN/sudo#" \
      "${msys_patch[@]}" "$DEPLOY_DIR/myapp-deploy" > "$2"
  if [ "$MSYS_HOST" = 1 ]; then grep -q "TEST ONLY (Git Bash)" "$2" || { echo "symlink patch did not apply"; exit 1; }; fi
}

new_root() {  # $1 name, [$2 max bundle bytes], [$3 health timeout]
  ROOT="$BASE/${1//[^A-Za-z0-9]/-}"
  mkdir -p "$ROOT/releases" "$ROOT/env" "$ROOT/tmp" "$ROOT/state" "$ROOT/art"
  export DEPLOY_TEST_ROOT="$ROOT"
  make_script "$ROOT" "$ROOT/myapp-deploy" "${2:-}" "${3:-}"
}

sha_of() { printf '%s' "$1" | sha1sum | cut -c1-40; }

# A complete app.env (all four required names). VERSION= comes first so that
# envtag can identify it; the values are fake but distinctive for leak checks.
complete_env() {
  printf 'VERSION=%s\nDATABASE_URL=postgresql://fake:not-a-real-db-pw@db.invalid/x\nREDIS_URL=redis://127.0.0.1:6379\nMFA_ENCRYPTION_KEY=not-a-real-mfa-key\nTRUSTED_PROXY_HOP_COUNT=1\n' "$1"
}
env_is_complete() {
  local n
  for n in DATABASE_URL REDIS_URL MFA_ENCRYPTION_KEY TRUSTED_PROXY_HOP_COUNT; do
    grep -q "^$n=." "$ROOT/env/app.env" 2>/dev/null || return 1
  done
}
no_values_logged() { ! grep -qE 'not-a-real-db-pw|not-a-real-mfa-key|redis://127' "$ROOT/out.log"; }

artifact() {  # $1 name, $2 health-mode, $3 worker-mode, [$4 env|none]
  local d="$ROOT/art/$1"; rm -rf "$d"; mkdir -p "$d/src/.next" "$d/b"
  echo "$2" > "$d/src/health-mode"; echo "$3" > "$d/src/worker-mode"; echo "$1" > "$d/src/.next/BUILD_ID"
  tar -czf "$d/b/release.tar.gz" -C "$d/src" .
  if [ "${4:-env}" = env ]; then complete_env "$1" > "$d/b/app.env"; fi
  (cd "$d/b" && tar -cf ../bundle.tar release.tar.gz $( [ -f app.env ] && echo app.env ))
  sha256sum "$d/b/release.tar.gz" | cut -d' ' -f1 > "$d/sum"
}

command_for() { echo "$(sha_of "$1") $(cat "$ROOT/art/$1/sum")"; }
deploy() {  # $1 artifact, [$2 override command]
  SSH_ORIGINAL_COMMAND="${2:-$(command_for "$1")}" bash "$ROOT/myapp-deploy" < "$ROOT/art/$1/bundle.tar" > "$ROOT/out.log" 2>&1
  RC=$?
}
deploy_signal() {  # $1 artifact, $2 signal, $3 extra delay, [$4 log line | file:<path> to wait for first]
  : > "$ROOT/out.log"   # the baseline's log must not satisfy the wait below
  SSH_ORIGINAL_COMMAND="$(command_for "$1")" bash "$ROOT/myapp-deploy" < "$ROOT/art/$1/bundle.tar" > "$ROOT/out.log" 2>&1 &
  local pid=$! waited=0
  if [ -n "${4:-}" ]; then   # wait (max 60 s) until the deployment has reached that point
    if [[ "$4" == file:* ]]; then
      until [ -e "${4#file:}" ] || [ "$waited" -ge 600 ]; do sleep 0.1; waited=$((waited + 1)); done
    else
      until grep -q -- "$4" "$ROOT/out.log" 2>/dev/null || [ "$waited" -ge 600 ]; do sleep 0.1; waited=$((waited + 1)); done
    fi
  fi
  sleep "$3"; kill -s "$2" "$pid"; wait "$pid"; RC=$?
}

current() { [ -L "$ROOT/current" ] && basename "$(readlink -f "$ROOT/current")" || echo "-"; }
envtag() { head -1 "$ROOT/env/app.env" 2>/dev/null || echo "none"; }
last_restart() { grep "restart $1" "$ROOT/state/calls" 2>/dev/null | tail -1; }
check() {  # $1 label, $2 condition (evaluated)
  if eval "$2"; then PASS=$((PASS + 1)); printf '    ok    %s\n' "$1"
  else FAIL=$((FAIL + 1)); printf '    FAIL  %s   [%s]\n' "$1" "$2"; sed 's/^/          | /' "$ROOT/out.log" | tail -10; fi
}
check_log() { PAT="$2"; check "$1" 'grep -q -- "$PAT" "$ROOT/out.log"'; }
check_clean() {
  check "no temporary files left" '[ -z "$(find "$ROOT/tmp" -mindepth 1 -type d -name "deploy.*" | head -1)" ] && [ -z "$(find "$ROOT/releases" -maxdepth 1 -name ".*.partial" | head -1)" ] && [ ! -e "$ROOT/.current.new" ] && [ ! -e "$ROOT/env/.app.env.new" ]'
}
stop_app() { [ -f "$ROOT/state/app.pid" ] && kill "$(cat "$ROOT/state/app.pid")" 2>/dev/null; sleep 0.3; }

baseline() { artifact A ok ok; deploy A; A=$(sha_of A); [ "$RC" = 0 ] || { echo "baseline failed:"; cat "$ROOT/out.log"; }; }

expect_success() {  # $1 label, $2 health-mode, $3 log pattern
  echo "== $1"; new_root "ok-$2" "" 20; baseline; artifact B "$2" ok; deploy B; B=$(sha_of B)
  check "exit 0" '[ "$RC" = 0 ]'
  check "current is B" '[ "$(current)" = "$B" ]'
  check "app.env is B" '[ "$(envtag)" = VERSION=B ]'
  check "app, then worker, restarted on B with B env" '[ "$(tail -2 "$ROOT/state/calls" | tr "\n" "|")" = "restart myapp.service release=$B env=VERSION=B|restart myapp-worker.service release=$B env=VERSION=B|" ]'
  check_log "log: $3" "$3"
  check_clean
  stop_app
}

expect_rollback() {  # $1 label, $2 health-mode, $3 worker-mode, $4 log pattern, [env vars...]
  local label="$1" hm="$2" wm="$3" pat="$4"; shift 4
  echo "== $label"; new_root "rb-$label"; baseline; artifact B "$hm" "$wm"; B=$(sha_of B)
  env "$@" bash -c 'true'   # validate var syntax
  local var; for var in "$@"; do export "${var?}"; done
  deploy B
  for var in "$@"; do unset "${var%%=*}"; done
  check "exit 1 (rolled back)" '[ "$RC" = 1 ]'
  check "current back to A" '[ "$(current)" = "$A" ]'
  check "app.env restored to A" '[ "$(envtag)" = VERSION=A ]'
  check "app restarted on A with A env" '[ "$(last_restart myapp.service)" = "restart myapp.service release=$A env=VERSION=A" ]'
  check "worker restarted on A with A env" '[ "$(last_restart myapp-worker.service)" = "restart myapp-worker.service release=$A env=VERSION=A" ]'
  check "worker restarted after the app" '[ "$(tail -1 "$ROOT/state/calls")" = "restart myapp-worker.service release=$A env=VERSION=A" ]'
  check "failed release B removed" '[ ! -e "$ROOT/releases/$B" ]'
  check_log "log: $pat" "$pat"
  check_log "log: rollback complete" "rollback complete"
  check_clean
  stop_app
}

# ---------------------------------------------------------------------------
echo "### Health gate: accepted"
expect_success "200 healthy" ok "health: ok (HTTP 200, database ok, redis ok, queue ok)"
expect_success "503 queue-only, accepted with a warning" queue "WARNING: only the notification queue check is failing (HTTP 503, database ok, redis ok, queue error)"
expect_success "slow start (connections refused for 3 s)" slow "health: ok"
expect_success "transient database error, then healthy" dbthenok "health: ok"

echo "### Health gate: rejected -> rollback"
expect_rollback "503 database error, retried, never accepted" db ok "not healthy within 8s (last: HTTP 503, database error"
expect_rollback "503 redis error" redis ok "last: HTTP 503, database ok, redis error, queue error"
expect_rollback "app never starts" never ok "last: not answering yet (curl exit 7)"
expect_rollback "invalid JSON" badjson ok "response is not valid JSON"
expect_rollback "missing checks.queue" missing ok "expected exactly checks.database, checks.redis and checks.queue"
expect_rollback "extra top-level field" extra ok "expected exactly the fields status and checks"
expect_rollback "HTTP 200 contradicting its checks" contradict ok 'HTTP 200 but status "ok" with database ok, redis ok, queue error'
expect_rollback "unknown check value" badvalue ok 'checks.redis is not "ok" or "error"'
expect_rollback "HTTP 503 with every check ok" degradedok ok 'HTTP 503 but status "degraded" with database ok, redis ok, queue ok'
expect_rollback "JSON array body" array ok "response is not a JSON object"
expect_rollback "HTTP 500" s500 ok "unexpected HTTP status 500"

echo "### Worker -> rollback of both services and app.env"
expect_rollback "worker crash-looping" ok crash "worker: FAILED: myapp-worker.service is activating/auto-restart"
expect_rollback "worker restarted between checks" ok flap "worker: FAILED: did not stay running"

echo "### Every production step can fail -> rollback"
expect_rollback "app.env install fails" ok ok "could not stage app.env" FAIL_ENV_INSTALL=1
B_SHA=$(sha_of B)
expect_rollback "current switch fails" ok ok "could not switch current" "FAIL_SWITCH_TO=$B_SHA"
expect_rollback "app restart fails" ok ok "could not restart myapp.service" "FAIL_RESTART=myapp.service@$B_SHA"
expect_rollback "worker restart fails" ok ok "could not restart myapp-worker.service" "FAIL_RESTART=myapp-worker.service@$B_SHA"

echo "### Interrupted deployments"
echo "== SIGTERM while the health gate waits -> rollback"
new_root sigterm "" 30; baseline; artifact B never ok; B=$(sha_of B); deploy_signal B TERM 2 "deploying "
check "exit 1 (rolled back)" '[ "$RC" = 1 ]'
check "current back to A" '[ "$(current)" = "$A" ]'
check "app.env restored to A" '[ "$(envtag)" = VERSION=A ]'
check "worker restarted on A last" '[ "$(tail -1 "$ROOT/state/calls")" = "restart myapp-worker.service release=$A env=VERSION=A" ]'
check_log "log: unexpected exit" "unexpected exit (status 143) during the deployment; rolling back"
check_clean; stop_app
echo "== SIGHUP (SSH connection dropped) is ignored -> deployment completes"
new_root sighup "" 20; baseline; artifact B slow ok; B=$(sha_of B); deploy_signal B HUP 1 "deploying "
check "exit 0" '[ "$RC" = 0 ]'
check "current is B" '[ "$(current)" = "$B" ]'
check_clean; stop_app
echo "== SIGTERM before any production change -> stops, nothing touched"
new_root sigterm-early; baseline; artifact B ok ok; B=$(sha_of B)
# The extraction stand-in pauses and drops a marker: the signal then provably
# arrives before any production change (a fixed delay raced process start-up).
export PAUSE_EXTRACT=5; deploy_signal B TERM 0.5 "file:$ROOT/state/extract-started"; unset PAUSE_EXTRACT
check "exit 143 (terminated)" '[ "$RC" = 143 ]'
check "never reached production" '! grep -q "deploying " "$ROOT/out.log"'
check "current still A" '[ "$(current)" = "$A" ]'
check "app.env still A" '[ "$(envtag)" = VERSION=A ]'
check "no service restarted after the baseline" '[ "$(wc -l < "$ROOT/state/calls")" = 2 ]'
check "B not left behind" '[ ! -e "$ROOT/releases/$B" ]'
check_clean; stop_app

echo "### Rollback failures and first deployments"
echo "== previous release broken too -> exit 2"
new_root rollback-fails; baseline; echo db > "$ROOT/releases/$A/health-mode"; artifact B db ok; deploy B
check "exit 2" '[ "$RC" = 2 ]'
check_log "log: CRITICAL" "CRITICAL: rollback did not come back healthy"
check "current back to A anyway" '[ "$(current)" = "$A" ]'
check "app.env restored to A" '[ "$(envtag)" = VERSION=A ]'
check "worker still restarted" '[ "$(tail -1 "$ROOT/state/calls")" = "restart myapp-worker.service release=$A env=VERSION=A" ]'
stop_app
echo "== first deployment succeeds"
new_root first-ok; artifact A ok ok; deploy A; A=$(sha_of A)
check "exit 0" '[ "$RC" = 0 ]'; check "current is A" '[ "$(current)" = "$A" ]'; check_clean; stop_app
echo "== first deployment fails -> no release left current, exit 2"
new_root first-fails; artifact A db ok; deploy A; A=$(sha_of A)
check "exit 2" '[ "$RC" = 2 ]'
check_log "log: CRITICAL first deployment" "CRITICAL: first deployment failed"
check "current link removed" '[ ! -e "$ROOT/current" ] && [ ! -L "$ROOT/current" ]'
check "new app.env kept (there was none before)" '[ "$(envtag)" = VERSION=A ]'
check_log "log: keeping new app.env" "no previous app.env existed; keeping the newly installed one"
check "failed release removed" '[ ! -e "$ROOT/releases/$A" ]'
check "both services restarted without a release" '[ "$(tail -2 "$ROOT/state/calls" | tr "\n" "|")" = "restart myapp.service release=none env=VERSION=A|restart myapp-worker.service release=none env=VERSION=A|" ]'
check_clean; stop_app

echo "### The VPS today: current -> /srv/myapp/releases/first (absolute link)"
setup_first() {
  mkdir -p "$ROOT/releases/first"; echo ok > "$ROOT/releases/first/health-mode"; echo ok > "$ROOT/releases/first/worker-mode"
  complete_env first > "$ROOT/env/app.env"; "$REAL_LN" -s "$ROOT/releases/first" "$ROOT/current"
}
echo "== deploy over 'first' succeeds"
new_root first-layout-ok; setup_first; artifact B ok ok; deploy B; B=$(sha_of B)
check "exit 0" '[ "$RC" = 0 ]'; check "current is B" '[ "$(current)" = "$B" ]'
check "current is now a relative link" '[ "$(readlink "$ROOT/current")" = "releases/$B" ]'
check "previous app.env kept as backup" '[ "$(head -1 "$ROOT/env/app.env.previous")" = VERSION=first ]'
check "'first' kept" '[ -d "$ROOT/releases/first" ]'
stop_app
echo "== failing deploy over 'first' rolls back to it"
new_root first-layout-rb; setup_first; artifact B db ok; deploy B; B=$(sha_of B)
check "exit 1" '[ "$RC" = 1 ]'; check "current back to first" '[ "$(current)" = first ]'
check "app.env back to first" '[ "$(envtag)" = VERSION=first ]'
check "app restarted on first" '[ "$(last_restart myapp.service)" = "restart myapp.service release=first env=VERSION=first" ]'
check "worker restarted on first" '[ "$(last_restart myapp-worker.service)" = "restart myapp-worker.service release=first env=VERSION=first" ]'
stop_app
echo "== VPS now: 'first' current, app.env deleted -> deploy installs app.env (mode 600)"
new_root first-noenv-ok; setup_first; rm -f "$ROOT/env/app.env"; artifact B ok ok; deploy B; B=$(sha_of B)
check "exit 0" '[ "$RC" = 0 ]'; check "current is B" '[ "$(current)" = "$B" ]'
check "app.env installed" '[ "$(envtag)" = VERSION=B ]'
[ "$MSYS_HOST" = 0 ] && check "app.env mode 600" '[ "$(stat -c %a "$ROOT/env/app.env")" = 600 ]'
check "no stale backup created" '[ ! -e "$ROOT/env/app.env.previous" ]'
check "app and worker started with the new app.env" '[ "$(tail -2 "$ROOT/state/calls" | tr "\n" "|")" = "restart myapp.service release=$B env=VERSION=B|restart myapp-worker.service release=$B env=VERSION=B|" ]'
check_clean; stop_app
echo "== VPS now, failing deploy -> back to 'first', new app.env kept for it"
new_root first-noenv-rb; setup_first; rm -f "$ROOT/env/app.env"; artifact B db ok; deploy B; B=$(sha_of B)
check "exit 1 (rolled back)" '[ "$RC" = 1 ]'; check "current back to first" '[ "$(current)" = first ]'
check "new app.env kept" '[ "$(envtag)" = VERSION=B ]'
check "app restarted on first with the new app.env" '[ "$(last_restart myapp.service)" = "restart myapp.service release=first env=VERSION=B" ]'
check "worker restarted on first with the new app.env" '[ "$(last_restart myapp-worker.service)" = "restart myapp-worker.service release=first env=VERSION=B" ]'
check_clean; stop_app

echo "### The VPS right now: app.env holds only TRUSTED_PROXY_HOP_COUNT"
TPHC_ONLY='TRUSTED_PROXY_HOP_COUNT=1'
setup_incomplete_env() {  # $1 content of the existing (incomplete) app.env
  setup_first; printf '%s\n' "$1" > "$ROOT/env/app.env"
}
echo "== deploy succeeds: complete app.env installed, old one kept as app.env.previous"
new_root tphc-only-ok; setup_incomplete_env "$TPHC_ONLY"; artifact B ok ok; deploy B; B=$(sha_of B)
check "exit 0" '[ "$RC" = 0 ]'; check "current is B" '[ "$(current)" = "$B" ]'
check "app.env is the new, complete file" '[ "$(envtag)" = VERSION=B ] && env_is_complete'
check "old file preserved verbatim as app.env.previous" '[ "$(cat "$ROOT/env/app.env.previous")" = "$TPHC_ONLY" ]'
check_log "log: previous incomplete (names only)" "previous app.env is incomplete (no value for: DATABASE_URL REDIS_URL MFA_ENCRYPTION_KEY)"
check "app and worker on B with the new app.env" '[ "$(tail -2 "$ROOT/state/calls" | tr "\n" "|")" = "restart myapp.service release=$B env=VERSION=B|restart myapp-worker.service release=$B env=VERSION=B|" ]'
check "no values in the log" 'no_values_logged'
check_clean; stop_app

expect_keep_new_env() {  # $1 label, $2 previous env content, $3 health-mode, $4 worker-mode, [$5 signal]
  echo "== $1"
  PREV_CONTENT="$2"   # check() evaluates in its own scope, where $2 is something else
  new_root "keep-$1"; setup_incomplete_env "$2"; artifact B "$3" "$4"; B=$(sha_of B)
  if [ -n "${5:-}" ]; then deploy_signal B "$5" 2 "deploying "; else deploy B; fi
  check "exit 1 (rolled back)" '[ "$RC" = 1 ]'
  check "current back to first" '[ "$(current)" = first ]'
  check "incomplete file NOT restored: app.env is the new, complete one" '[ "$(envtag)" = VERSION=B ] && env_is_complete'
  check "old file still preserved as app.env.previous" '[ "$(cat "$ROOT/env/app.env.previous")" = "$PREV_CONTENT" ]'
  check_log "log: keeping the new one" "previous app.env was incomplete; keeping the new one"
  check "app restarted on first with the new app.env" '[ "$(last_restart myapp.service)" = "restart myapp.service release=first env=VERSION=B" ]'
  check "worker restarted on first with the new app.env" '[ "$(last_restart myapp-worker.service)" = "restart myapp-worker.service release=first env=VERSION=B" ]'
  check_log "log: rollback complete" "rollback complete; first is running"
  check "failed release B removed" '[ ! -e "$ROOT/releases/$B" ]'
  check "no values in the log" 'no_values_logged'
  check_clean; stop_app
}
expect_keep_new_env "health gate fails"               "$TPHC_ONLY" db ok
expect_keep_new_env "worker fails"                    "$TPHC_ONLY" ok crash
expect_keep_new_env "SIGTERM during the health gate"  "$TPHC_ONLY" never ok TERM
expect_keep_new_env "previous has an empty value"     "$(complete_env first | sed 's/^DATABASE_URL=.*/DATABASE_URL=/')" db ok
expect_keep_new_env "previous has a quoted empty value" "$(complete_env first | sed 's/^MFA_ENCRYPTION_KEY=.*/MFA_ENCRYPTION_KEY=""/')" db ok

echo "== a complete previous app.env IS restored on rollback"
new_root complete-prev-rb; setup_first; artifact B db ok; deploy B
check "exit 1" '[ "$RC" = 1 ]'; check "app.env back to first" '[ "$(envtag)" = VERSION=first ] && env_is_complete'
check_log "log: restored" "restored the previous app.env"
check "no 'incomplete' message" '! grep -q "incomplete" "$ROOT/out.log"'
stop_app

echo "== an incomplete app.env in the bundle is rejected before any change"
new_root incoming-incomplete; setup_incomplete_env "$TPHC_ONLY"; artifact C ok ok
printf 'VERSION=C\nDATABASE_URL=postgresql://fake:not-a-real-db-pw@db.invalid/x\n' > "$ROOT/art/C/b/app.env"
(cd "$ROOT/art/C/b" && tar -cf ../bundle.tar release.tar.gz app.env); deploy C
check "exit 3 (rejected)" '[ "$RC" = 3 ]'
check_log "log: names the missing variables" "app.env in the bundle has no value for: REDIS_URL MFA_ENCRYPTION_KEY TRUSTED_PROXY_HOP_COUNT"
check "existing app.env untouched" '[ "$(cat "$ROOT/env/app.env")" = "$TPHC_ONLY" ]'
check "current still first" '[ "$(current)" = first ]'
check "no service restarted" '[ ! -s "$ROOT/state/calls" ]'
check "no values in the log" 'no_values_logged'
check_clean

echo "### Retention"
echo "== 'first' + seven deploys"
new_root retention; setup_first
for r in R1 R2 R3 R4 R5 R6 R7; do artifact $r ok ok; deploy $r; [ "$RC" = 0 ] || echo "    deploy $r exit $RC"; sleep 1.1; done
kept="$(ls "$ROOT/releases" | sort | tr '\n' ' ')"
want="$( (echo first; for r in R3 R4 R5 R6 R7; do sha_of $r; done) | sort | tr '\n' ' ')"
check "R3..R7 kept, R1 and R2 pruned, 'first' untouched" '[ "$kept" = "$want" ]'
check "current is R7" '[ "$(current)" = "$(sha_of R7)" ]'
echo "== previous kept even when it is the oldest"
artifact R8 ok ok; touch -m -d "2020-01-01" "$ROOT/releases/$(sha_of R7)"; deploy R8
check "deploy R8 exit 0" '[ "$RC" = 0 ]'
check "R7 (previous) kept" '[ -d "$ROOT/releases/$(sha_of R7)" ]'
check "5 newest + previous + 'first'" '[ "$(ls "$ROOT/releases" | wc -l)" = 7 ]'
stop_app

echo "### Rejected before any change (exit 3)"
new_root inputs; baseline; artifact B ok ok
check_rejected() {
  check "$1: exit 3" '[ "$RC" = 3 ]'; check_log "$1: log" "$2"
  check "$1: current still A" '[ "$(current)" = "$A" ]'; check "$1: env still A" '[ "$(envtag)" = VERSION=A ]'
  check "$1: B not extracted" '[ ! -e "$ROOT/releases/$(sha_of B)" ]'
}
deploy B "$(sha_of B)";                                        check_rejected "one argument" "expected"
deploy B "$(command_for B) extra";                             check_rejected "three arguments" "expected"
deploy B "$(sha_of B | tr a-f A-F) $(cat "$ROOT/art/B/sum")";  check_rejected "uppercase sha" "expected"
deploy B "$(sha_of B);id $(cat "$ROOT/art/B/sum")";            check_rejected "shell metacharacters" "expected"
deploy B "$(sha_of B) $(sha_of x)$(sha_of y | cut -c1-24)";    check_rejected "checksum mismatch" "checksum does not match"
cp "$ROOT/art/B/bundle.tar" "$ROOT/art/B/bundle.ok"
(cd "$ROOT/art/B/b" && echo x > evil.sh && tar -cf ../bundle.tar release.tar.gz app.env evil.sh)
deploy B;                                                      check_rejected "extra bundle entry" "invalid bundle"
cp "$ROOT/art/B/bundle.ok" "$ROOT/art/B/bundle.tar"
if [ "$MSYS_HOST" = 1 ]; then touch "$ROOT/lock.held"; deploy B; rm -f "$ROOT/lock.held"
else exec 8>"$ROOT/tmp/deploy.lock"; flock -n 8; deploy B; exec 8>&-; fi
check_rejected "lock held" "another deployment is in progress"
check_clean; stop_app
new_root small-cap 2000; artifact A ok ok; deploy A
check "bundle over the cap: exit 3" '[ "$RC" = 3 ]'; check_log "bundle over the cap: log" "larger than 2000 bytes"

echo "### Environment-only redeploy of the current commit"
new_root env-only; baseline
mkdir -p "$ROOT/art/A2/b"; cp "$ROOT/art/A/b/release.tar.gz" "$ROOT/art/A2/b/"; complete_env A2 > "$ROOT/art/A2/b/app.env"
(cd "$ROOT/art/A2/b" && tar -cf ../bundle.tar release.tar.gz app.env); cp "$ROOT/art/A/sum" "$ROOT/art/A2/sum"
deploy A2 "$A $(cat "$ROOT/art/A/sum")"
check "exit 0" '[ "$RC" = 0 ]'; check "same release" '[ "$(current)" = "$A" ]'; check "env updated" '[ "$(envtag)" = VERSION=A2 ]'
check_log "log: reuse" "environment-only redeploy"
check "both services restarted with the new env" '[ "$(tail -2 "$ROOT/state/calls" | tr "\n" "|")" = "restart myapp.service release=$A env=VERSION=A2|restart myapp-worker.service release=$A env=VERSION=A2|" ]'
artifact A3 ok ok; deploy A3 "$A $(cat "$ROOT/art/A3/sum")"
check "same commit, different artifact: exit 3" '[ "$RC" = 3 ]'
check_log "same commit, different artifact: log" "different artifact"
check "same commit, different artifact: release kept" '[ -d "$ROOT/releases/$A" ] && [ "$(current)" = "$A" ]'
stop_app

echo; echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
