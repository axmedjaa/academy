# Production server files

Server-side half of the deployment. The GitHub side is the `deploy` job in
`.github/workflows/ci.yml`; database migrations are a separate manual step
(`docs/production-migrations.md`).

| File | Installed as | Purpose |
|---|---|---|
| `myapp-deploy` | `/usr/local/bin/myapp-deploy` (root, 755) | Forced command of the `deploy` SSH key: verify, extract, switch, restart, health-check, roll back |
| `myapp-safe-extract` | `/usr/local/bin/myapp-safe-extract` (root, 755) | Bundle and release extraction with Python 3.12's `data` filter plus stricter checks |
| `myapp-worker.service` | `/etc/systemd/system/myapp-worker.service` | BullMQ worker (`dist/worker.mjs`) |
| `myapp-umask.conf` | `/etc/systemd/system/myapp.service.d/umask.conf` | `UMask=0002` for the existing web service, so old releases stay deletable |
| (created in install step 6) | `/etc/systemd/system/myapp.service.d/envfile.conf` | Makes `/srv/myapp/env/app.env` **required** for `myapp.service` (no `-` prefix) |
| `myapp-deploy.sudoers` | `/etc/sudoers.d/myapp-deploy` (root, 440) | `deploy` may restart exactly `myapp.service` and `myapp-worker.service` |
| `nginx-myapp.conf` | reference for `/etc/nginx/sites-available/myapp` | What the app needs from its single reverse proxy (compare, don't overwrite blindly) |
| `tests/` | not installed | `bash deploy/tests/run-deploy-tests.sh`, `bash deploy/tests/test-workflow-env.sh`, `python3 -I deploy/tests/test_safe_extract.py deploy/myapp-safe-extract` |

## GitHub `production` environment secrets

| Secret | Used for |
|---|---|
| `APP_ENV` | The complete production environment file (plain `NAME=value` lines, LF line endings, no `export`). Must contain `DATABASE_URL`, `REDIS_URL` (`redis://127.0.0.1:6379`) and `MFA_ENCRYPTION_KEY`; normally also `APP_URL`, `EMAIL_FROM`, `RESEND_API_KEY` and the R2 settings. |
| `TRUSTED_PROXY_HOP_COUNT` | Optional. When set (to `1`: one Nginx), it replaces that one line in `APP_ENV`; otherwise `APP_ENV` must contain it. |
| `DEPLOY_HOST` | `2.24.58.228` |
| `DEPLOY_KNOWN_HOSTS` | The VPS host key line(s), for strict host-key checking |
| `DEPLOY_SSH_KEY` | Private key whose public half is the `restrict,command=...` line of `deploy` |

Individual secrets never reach the server by themselves: the deploy job writes
`app.env` from `APP_ENV` (plus `TRUSTED_PROXY_HOP_COUNT` if that secret is
set), checks the required names and that `TRUSTED_PROXY_HOP_COUNT` appears
exactly once as a whole number of at least 1, logs only variable names, and
ships the file inside the bundle on SSH stdin. `myapp-deploy` installs it as
`/srv/myapp/env/app.env` with mode 600 (directory 700, owner `deploy`);
systemd reads it as root for both services.

## Plain HTTP on the IP address: what does not work yet

HSTS and the CSP's `upgrade-insecure-requests` are sent only when the release
was **built** with `APP_HTTPS_ENABLED=true` (GitHub repository variable
`APP_HTTPS_ENABLED`, passed to the CI build step; `next build` fixes the
headers, so setting it in `app.env` has no effect). Leave it unset while the
site is plain http: with it, browsers rewrite every script, stylesheet, font
and image URL to `https://` and the pages render unstyled. Every other
security header is sent either way.

Over `http://2.24.58.228`, pages and assets load, but session, MFA and
return-path cookies are still `Secure` in production, so browsers refuse to
store them and **sign-in cannot work** until the site is served over HTTPS.

Fix that by adding TLS (a domain with a Let's Encrypt certificate is the
standard route), not by turning these protections off. Once HTTPS works, set
the repository variable `APP_HTTPS_ENABLED` to `true` and deploy a new build.
HSTS is cached by browsers for a year (`max-age=31536000`, with
`includeSubDomains`), so only turn it on when HTTPS is permanent.

## What a deployment does

1. Takes `/srv/myapp/tmp/deploy.lock` (`flock`), validates
   `SSH_ORIGINAL_COMMAND` = `<40-hex sha> <64-hex sha256>`.
2. Reads the bundle from stdin (max 620 MiB), accepts only `release.tar.gz`
   (+ optional `app.env`), verifies the checksum, refuses an `app.env` that
   lacks a value for any of `DATABASE_URL`, `REDIS_URL`,
   `MFA_ENCRYPTION_KEY`, `TRUSTED_PROXY_HOP_COUNT`, and extracts the release
   safely into `/srv/myapp/releases/<sha>` (max 3 GiB / 150,000 entries).
   Nothing in production has changed yet; any problem here exits with 3.
3. Installs `app.env` atomically (mode 600; the old file is always saved as
   `app.env.previous`), switches `/srv/myapp/current` atomically, restarts
   `myapp.service`, waits up to 90 s for the health gate, restarts
   `myapp-worker.service`, and requires the worker to keep the same PID for
   10 s.
4. On any failure in step 3, including the script being killed, it puts
   `current` back, restarts both services and checks them again. The
   previous `app.env` is restored **only if it was complete** (all four
   required variables with non-empty values). If it was missing or incomplete
   (for example only `TRUSTED_PROXY_HOP_COUNT`), the new complete file is
   kept, because restoring it could only produce a release that cannot start;
   the old file stays available in `app.env.previous`.
5. On success it keeps the 5 most recently deployed releases plus current and
   previous. Directories not named after a commit (such as `first`) are never
   deleted automatically.

Health gate (`/api/health`, unchanged): HTTP 200 with `status "ok"` and all
of `checks.database`, `checks.redis`, `checks.queue` = `"ok"` passes. HTTP 503
with `status "degraded"`, database and Redis `"ok"` and queue `"error"` passes
with a logged warning. Database or Redis `"error"` is retried until 90 s and
then fails. Anything else (unreadable or invalid JSON, missing or extra
fields, unknown values, other status codes) fails immediately.

The worker check proves the process stays up; it does not prove that jobs are
being processed.

Exit codes: 0 deployed, 1 failed and rolled back, 2 failed and rollback
failed (or a first deployment failed), 3 rejected before any change.
Logs: `journalctl -t myapp-deploy`.

## Install

Run on your computer from the repository root, then on the VPS as `sysadmin`.
None of these commands print values from `app.env`.

The order matters: the new `myapp-deploy` restarts **both** services through
sudo, so the sudo rule and the worker unit must exist before the script is
replaced (otherwise every deployment fails at the worker step and rolls back).
Nothing here restarts the running app; the first deployment afterwards does.

### 0. Find out why the last deployment did not start (read-only)

```bash
ssh sysadmin@2.24.58.228
sudo journalctl -u myapp --since "2026-11-10 12:02" --until "2026-11-10 12:05" --no-pager \
  | grep -iE 'invalid|missing|refus|error|listen'
```

The app names a failing variable but never prints its value. Fix the `APP_ENV`
secret first if a variable is named here; the same error would make the next
deployment roll back too.

### 1. Check the server (read-only)

```bash
stat -c '%U:%G %a %n' /srv/myapp /srv/myapp/releases /srv/myapp/tmp /srv/myapp/env /srv/myapp/shared
readlink /srv/myapp/current
sudo -u deploy test -w /srv/myapp && sudo -u deploy test -w /srv/myapp/releases && echo "deploy can write /srv/myapp and releases"
command -v flock curl python3 /usr/bin/node /usr/bin/env
python3 -c 'import sys, tarfile; print(sys.version.split()[0], "data_filter:", hasattr(tarfile, "data_filter"))'
test -f /srv/myapp/current/dist/worker.mjs && echo "worker bundle present" || echo "worker bundle MISSING in the current release"
sudo stat -c '%a %U:%G %s bytes' /srv/myapp/env/app.env
sudo cut -s -d= -f1 /srv/myapp/env/app.env | sort          # variable NAMES only
ls -d /srv/myapp/tmp/deploy.* 2>/dev/null                  # leftovers of a killed run (remove them)
systemctl cat myapp.service
sudo grep -rn 'myapp' /etc/sudoers /etc/sudoers.d/
sudo -l -U deploy
curl -s http://127.0.0.1:3000/api/health; echo
```

Continue only if `deploy` can write both directories and `data_filter: True`.
If the current release has no `dist/worker.mjs`, a later rollback to it can
restart the app but not the worker, and reports exit code 2.

### 2. Copy the files (on your computer)

```bash
ssh sysadmin@2.24.58.228 'rm -rf /tmp/myapp-install && mkdir -m 700 /tmp/myapp-install'
scp deploy/myapp-deploy deploy/myapp-safe-extract deploy/myapp-worker.service \
    deploy/myapp-umask.conf deploy/myapp-deploy.sudoers \
    sysadmin@2.24.58.228:/tmp/myapp-install/
```

### 3. Check the copies (on the VPS)

```bash
cd /tmp/myapp-install
grep -lU $'\r' * && echo "STOP: Windows line endings found" || echo "line endings OK"
bash -n myapp-deploy && echo "myapp-deploy syntax OK"
python3 -I -c 'import ast, sys; ast.parse(open(sys.argv[1]).read()); print("myapp-safe-extract syntax OK")' myapp-safe-extract
sudo visudo -cf myapp-deploy.sudoers
```

### 4. Back up what will be replaced

```bash
B=/root/myapp-backup-$(date +%Y%m%d-%H%M); echo "$B"
sudo mkdir -m 700 "$B"
sudo cp -a /usr/local/bin/myapp-deploy "$B/"
sudo cp -a /etc/sudoers.d "$B/sudoers.d"
sudo cp -a /etc/systemd/system/myapp.service "$B/"
sudo test -d /etc/systemd/system/myapp.service.d && sudo cp -a /etc/systemd/system/myapp.service.d "$B/"
sudo cp -a /srv/myapp/env "$B/env"          # root-only copy; never displayed
```

Note the printed directory name; the rollback section needs it.

### 5. sudo rule (adds the worker; keeps the web-service rule)

```bash
sudo install -m 440 -o root -g root /tmp/myapp-install/myapp-deploy.sudoers /etc/sudoers.d/myapp-deploy
sudo visudo -cf /etc/sudoers.d/myapp-deploy
sudo visudo -c
sudo -l -U deploy
```

If step 1 showed the existing web-service rule in a different file, leave
that file alone: the duplicate rule is harmless.

### 6. systemd units and drop-ins

The environment-file drop-in replaces `myapp.service`'s
`EnvironmentFile=-/srv/myapp/env/app.env`: the empty `EnvironmentFile=` line
clears the old setting, the next one sets it again **without** the `-`. With
the `-`, a missing file lets the app start with no settings at all and crash;
without it, systemd refuses to start the service and says why. The worker
unit already requires the file.

```bash
sudo install -m 644 -o root -g root /tmp/myapp-install/myapp-worker.service /etc/systemd/system/myapp-worker.service
sudo install -d -m 755 /etc/systemd/system/myapp.service.d
sudo install -m 644 -o root -g root /tmp/myapp-install/myapp-umask.conf /etc/systemd/system/myapp.service.d/umask.conf
printf '[Service]\nEnvironmentFile=\nEnvironmentFile=/srv/myapp/env/app.env\n' \
  | sudo tee /etc/systemd/system/myapp.service.d/envfile.conf >/dev/null
sudo chmod 644 /etc/systemd/system/myapp.service.d/envfile.conf
sudo systemd-analyze verify /etc/systemd/system/myapp-worker.service /etc/systemd/system/myapp.service
sudo systemctl daemon-reload
systemctl show myapp.service -p EnvironmentFiles            # /srv/myapp/env/app.env (ignore_errors=no)
sudo systemctl enable myapp-worker.service                  # enable only: do NOT start it yet
```

Do not start the worker (`--now`) before the first successful deployment:
`app.env` on the server is incomplete until then, so the worker would only
crash-loop. The deployment starts it once the app has passed its health
gate. The drop-ins take effect at the next restart of `myapp.service`, which
the deployment also does.

### 7. Helpers and deploy script (last, so it never runs half-installed)

```bash
sudo install -m 755 -o root -g root /tmp/myapp-install/myapp-safe-extract /usr/local/bin/myapp-safe-extract
sudo install -m 755 -o root -g root /tmp/myapp-install/myapp-deploy /usr/local/bin/myapp-deploy
rm -rf /tmp/myapp-install
```

### 8. Nginx (compare with `nginx-myapp.conf`)

```bash
sudo nginx -T 2>/dev/null | grep -nE 'listen|server_name|proxy_pass|proxy_set_header|server_tokens|access_log'
```

Required: `proxy_pass http://127.0.0.1:3000`, `proxy_set_header Host $host`
and `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for` (or
`$remote_addr`): one proxy appending the client address is exactly what
`TRUSTED_PROXY_HOP_COUNT=1` describes. Recommended: `server_tokens off` and
an access log without query strings. To adopt the reference file:

```bash
scp deploy/nginx-myapp.conf sysadmin@2.24.58.228:/tmp/          # on your computer
sudo cp -a /etc/nginx/sites-available /root/nginx-sites-available.bak-$(date +%Y%m%d-%H%M)
sudo install -m 644 -o root -g root /tmp/nginx-myapp.conf /etc/nginx/sites-available/myapp
sudo ln -sfn /etc/nginx/sites-available/myapp /etc/nginx/sites-enabled/myapp
ls -l /etc/nginx/sites-enabled/          # leave exactly one site with default_server on port 80
sudo nginx -t && sudo systemctl reload nginx
```

Only one enabled site may claim `default_server` on port 80; disable the old
one (`sudo rm /etc/nginx/sites-enabled/<old>`) only after `nginx -t` passes
with the new one.

### 9. Deploy

Deployments only come from GitHub Actions. Either push a commit to `main`
(without `[skip ci]`), or open the latest run on `main` that built a release
artifact and choose **Re-run failed jobs**, which re-runs only "Deploy to
production" with that run's artifact (artifacts are kept for 14 days).

The first deployment with the new script installs the complete `app.env`
(the current one-variable file is saved as `app.env.previous` and is never
restored), switches `current`, restarts `myapp.service` (picking up both
drop-ins), passes the health gate, then starts the worker. Follow it with
`journalctl -t myapp-deploy -f` on the server.

## Verify

```bash
systemctl is-active myapp.service myapp-worker.service
systemctl show -p UMask myapp.service                       # UMask=0002
systemctl show -p MainPID,ActiveState,SubState myapp-worker.service
journalctl -u myapp-worker.service -n 30 --no-pager          # expect "worker.started"
sudo -u deploy sudo -n -l                                   # exactly the two restart rules
sudo -u deploy flock -n /srv/myapp/tmp/deploy.lock true && echo "lock usable by deploy"
sudo grep -c 'command="/usr/local/bin/myapp-deploy"' /home/deploy/.ssh/authorized_keys   # 1, line starts with restrict,
sudo stat -c '%a %U:%G' /srv/myapp/env/app.env              # 600 deploy:deploy (after a deployment)
sudo cut -s -d= -f1 /srv/myapp/env/app.env | sort           # all variable NAMES, no values
sudo grep -c '^TRUSTED_PROXY_HOP_COUNT=1$' /srv/myapp/env/app.env   # 1  (prints a count, not the file)
systemctl show myapp.service -p EnvironmentFiles -p UMask   # app.env (ignore_errors=no), 0002
curl -s http://127.0.0.1:3000/api/health; echo              # directly
curl -s http://127.0.0.1/api/health; echo                   # through Nginx
sudo ss -ltnp | grep -E ':3000|:6379'                       # 127.0.0.1 only
```

From your computer: `curl -s http://2.24.58.228/api/health` must answer, and
`curl -m 5 http://2.24.58.228:3000/` must time out.

After the next deployment from GitHub Actions:

```bash
journalctl -t myapp-deploy -n 40 --no-pager
readlink /srv/myapp/current
ls -lt /srv/myapp/releases
systemctl is-active myapp.service myapp-worker.service
curl -s http://127.0.0.1:3000/api/health; echo
```

## Roll back

**Automatic.** A failed deployment needs no action: the script restores
`current`, restores `app.env` only if the previous one was complete (see
"What a deployment does"), restarts both services and checks them. Exit code
1 in GitHub Actions means this worked; exit code 2 means it did not and the
steps below are needed.

**A release, by hand:**

```bash
ls -lt /srv/myapp/releases
sudo -u deploy bash -c 'cd /srv/myapp && ln -sfn releases/<release> .current.new && mv -fT .current.new current'
sudo systemctl restart myapp.service
curl -s http://127.0.0.1:3000/api/health; echo
sudo systemctl restart myapp-worker.service
```

**`app.env`, by hand** (only if the previous file is complete; the first
command must list all four names):

```bash
sudo grep -oE '^(DATABASE_URL|REDIS_URL|MFA_ENCRYPTION_KEY|TRUSTED_PROXY_HOP_COUNT)=.' /srv/myapp/env/app.env.previous | cut -d= -f1 | sort -u
sudo -u deploy bash -c 'cp -p /srv/myapp/env/app.env.previous /srv/myapp/env/.app.env.restore && mv -f /srv/myapp/env/.app.env.restore /srv/myapp/env/app.env'
sudo systemctl restart myapp.service myapp-worker.service
```

**This installation** (back to the files saved in step 4; set `B` to that
directory). This also restores the old deploy script, which the unchanged
workflow can use again immediately:

```bash
B=/root/myapp-backup-YYYYMMDD-HHMM
sudo systemctl disable --now myapp-worker.service
sudo rm -f /etc/systemd/system/myapp-worker.service \
           /etc/systemd/system/myapp.service.d/umask.conf \
           /etc/systemd/system/myapp.service.d/envfile.conf
sudo rmdir /etc/systemd/system/myapp.service.d 2>/dev/null || true
sudo test -d "$B/myapp.service.d" && sudo cp -a "$B/myapp.service.d" /etc/systemd/system/
sudo install -m 755 -o root -g root "$B/myapp-deploy" /usr/local/bin/myapp-deploy
sudo rm -f /etc/sudoers.d/myapp-deploy
sudo cp -a "$B/sudoers.d/." /etc/sudoers.d/
sudo visudo -c
sudo systemctl daemon-reload
sudo systemctl restart myapp.service
curl -s http://127.0.0.1:3000/api/health; echo
```

`/usr/local/bin/myapp-safe-extract` can stay; the old script does not use it.
`$B/env` holds the environment as it was before step 4; restore it with
`sudo cp -a "$B/env/." /srv/myapp/env/` only if you need exactly that state.
