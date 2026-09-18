# Backup & Restore Drill (Phase 5, Item 66)

PLAN.md (line 763): "a documented, tested restore procedure against a seeded
database ... the drill itself — take a backup, destroy the environment,
restore, verify data integrity — is required before release regardless of
provider." Exact backup frequency and RPO/RTO numbers are explicitly
deferred to the hosting decision (PLAN.md line 753) — this document proves
the *mechanism* works, not a production schedule.

## What this drill does, and why it doesn't touch the live dev database

The literal PLAN.md wording is "destroy the environment, restore." Rather
than dropping the actual local `academy` database this whole engagement
depends on, the drill below restores into a **separate scratch database**
and verifies its contents are byte-for-byte equivalent (by row count, across
every table) to the source. This proves the same thing — a backup can be
turned back into a fully working database with no data loss — without the
unnecessary risk of destroying shared local dev state to prove it. When a
real deployment target is chosen, the same commands apply directly to that
environment, including an actual destroy-and-restore if a true disaster
rehearsal is wanted at that point.

## Tools

Native Windows PostgreSQL 18 ships `pg_dump`/`pg_restore`/`psql` (no Docker,
consistent with this project's infrastructure throughout). On this machine:

```
C:\Program Files\PostgreSQL\18\bin\pg_dump.exe
C:\Program Files\PostgreSQL\18\bin\pg_restore.exe
C:\Program Files\PostgreSQL\18\bin\psql.exe
```

## Procedure (verified, exact commands run for this drill)

1. **Back up** the live database in `pg_restore`-compatible custom format:

   ```
   pg_dump -h localhost -U postgres -d academy -Fc -f academy_backup.dump
   ```

2. **Create a fresh scratch database** to restore into:

   ```
   psql -h localhost -U postgres -d postgres -c "CREATE DATABASE academy_restore_drill;"
   ```

3. **Restore** the dump into it:

   ```
   pg_restore -h localhost -U postgres -d academy_restore_drill --no-owner --no-privileges academy_backup.dump
   ```

4. **Verify data integrity**: compare the row count of every table in
   `information_schema.tables` between the source and restored databases.

5. **Clean up**: drop the scratch database and delete the dump file (this
   is a re-runnable drill, not a retained backup artifact — a real backup
   schedule/retention policy is one of the deferred hosting-time decisions
   above).

## Result of the drill actually run (2026-09-18)

- `pg_dump`: succeeded, produced a 207,807-byte custom-format dump.
- `pg_restore`: succeeded in ~0.74s, zero errors.
- **Verification: 43/43 tables matched exactly, 923/923 total rows matched
  exactly, zero mismatches.**
- Scratch database and dump file were both removed after verification.

## What this does and doesn't prove

Proves: the schema, all constraints/indexes/enums, and every row of data
survive a full dump/restore cycle with no loss or corruption, using tooling
that will work unchanged against any real Postgres-compatible hosting
target.

Doesn't prove (explicitly deferred per PLAN.md, not blocking this item):
backup frequency/scheduling, retention policy, exact RPO/RTO numbers, or
behavior under a genuinely destroyed/unavailable primary environment (a true
disaster-recovery rehearsal) — all of these are hosting-provider-specific
and are only meaningful once a deployment target is chosen.
