# Production Database Migrations

Deployment never touches the database schema. The CI/CD workflow deploys
every successful push to `main` automatically, and it does **not** run
migrations. A migration is therefore applied by hand, **before** the
commit that needs it reaches `main`.

## Rules

1. **Expand first, contract later.** A migration must work with the
   release that is running now. Between applying it and the deploy, the
   old code runs on the new schema; after a failed deploy, the deploy
   script rolls back to the old code, still on the new schema. Add columns
   (nullable or with a default), tables and indexes freely. Drop or rename
   only in a later migration, after no retained release uses the old shape.
2. **Never edit an applied migration.** Drizzle decides what is pending by
   timestamp: only migrations newer than the last applied one run
   (`drizzle-orm` compares `created_at`). An edited or back-dated file is
   silently skipped.
3. **One transaction.** `scripts/migrate.mjs` applies all pending
   migrations in a single transaction. If one fails, none are applied.
   Statements that cannot run in a transaction (for example
   `CREATE INDEX CONCURRENTLY`) are not supported.
4. **A tested backup comes first.** Every production migration is preceded
   by a backup that can be restored.

## Procedure

Replace `<sha>` with the pull request's head commit. Run the VPS commands as
`sysadmin` on `2.24.58.228`, not as `deploy` (that key can
only run the deploy script).

### 1. Prove it in CI

Open a pull request that contains the migration (`npm run db:generate`).
CI applies every migration to an empty database and runs the full test
suite. Do not continue unless the run is green.

### 2. Fetch that run's release artifact (on your computer)

Pull-request runs upload the same `release` artifact as `main`. It holds
`scripts/migrate.mjs`, the `drizzle/` folder and production `node_modules`.

```bash
gh run list --branch <pr-branch> --limit 1
gh run download <run-id> --name release --dir migrate-<sha>
cd migrate-<sha> && sha256sum -c release.sha256
scp release.tar.gz release.sha256 sysadmin@2.24.58.228:/tmp/
```

### 3. Unpack it on the VPS

```bash
cd /tmp && sha256sum -c release.sha256
sudo install -d -m 755 /srv/myapp/migrate
sudo /usr/local/bin/myapp-safe-extract release /tmp/release.tar.gz /srv/myapp/migrate/<sha>
```

### 4. See what will run

The command reads `DATABASE_URL` from the production environment file, the
same way the services do, and prints only migration names.

```bash
sudo systemd-run --wait --pipe --collect --quiet \
  --uid=nextjs --gid=nextjs \
  -p EnvironmentFile=/srv/myapp/env/app.env \
  -p WorkingDirectory=/srv/myapp/migrate/<sha> \
  /usr/bin/node --input-type=module -e '
    import fs from "node:fs"; import pg from "pg";
    const entries = JSON.parse(fs.readFileSync("drizzle/meta/_journal.json", "utf8")).entries;
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const { rows } = await client
      .query("select max(created_at) as last from drizzle.__drizzle_migrations")
      .catch(() => ({ rows: [{ last: 0 }] }));
    const last = Number(rows[0].last ?? 0);
    console.log("pending:", entries.filter((e) => e.when > last).map((e) => e.tag).join(", ") || "none");
    await client.end();'
```

### 5. Back up

Production runs on PostgreSQL 18 on the VPS (moved from Neon on
2026-11-24; see `deploy/README.md`). There are no instant Neon branches any
more: take a `pg_dump` right before migrating, check it with
`pg_restore --list`, and keep it until the release is confirmed. The client
must be at least the server's major version (`pg_dump --version`).

```bash
sudo install -d -m 700 /var/backups/myapp
sudo systemd-run --wait --collect --quiet \
  --uid=nextjs --gid=nextjs \
  -p EnvironmentFile=/srv/myapp/env/app.env \
  -p UMask=0077 \
  -p StandardOutput=file:/var/backups/myapp/pre-<sha>.dump \
  /bin/sh -c 'exec pg_dump --format=custom --no-owner "$$DATABASE_URL"'
sudo pg_restore --list /var/backups/myapp/pre-<sha>.dump | head
```

`$$` stops systemd from expanding the variable itself; the shell expands
it. While `pg_dump` runs, its command line (including the connection
string) is visible to other local users in `ps`.

### 6. Apply

```bash
sudo systemd-run --wait --pipe --collect --quiet \
  --uid=nextjs --gid=nextjs \
  -p EnvironmentFile=/srv/myapp/env/app.env \
  -p WorkingDirectory=/srv/myapp/migrate/<sha> \
  /usr/bin/node scripts/migrate.mjs
```

Expect `Running migrations against <host>/<database> ...` and then
`Migrations complete.` Run step 4 again: it must print `pending: none`.
The running release keeps serving throughout (rule 1).

If the application's database role cannot change the schema, put a
migration-only `DATABASE_URL` in a separate root-owned, mode-600 file and
pass that file to `EnvironmentFile=` in steps 4 to 6 instead.

### 7. Deploy

Merge the pull request. CI runs again on `main` and deploys automatically.
Then check on the VPS:

```bash
curl -s http://127.0.0.1:3000/api/health; echo
```

### 8. Clean up

```bash
sudo rm -rf /srv/myapp/migrate/<sha> /tmp/release.tar.gz /tmp/release.sha256
```

Keep the backup for as long as your retention policy says.

## When something fails

- **The migration fails:** its transaction is rolled back, so nothing was
  applied. Fix it in the pull request and start again from step 1. Do not
  merge.
- **The deploy fails after a successful migration:** the deploy script
  restores the previous release, which still works on the expanded schema
  (rule 1). Fix forward with a new commit.
- **Data is wrong:** restoring the backup discards every write made since
  it was taken. That is a deliberate, manual decision; stop the app and the
  worker first (`sudo systemctl stop myapp.service myapp-worker.service`),
  restore with `pg_restore --clean --if-exists --no-owner`, then start them
  again.
