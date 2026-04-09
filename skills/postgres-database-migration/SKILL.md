---
name: postgres-database-migration
description: |
  Use this skill for planning, testing, and safely executing PostgreSQL schema migrations — especially when working with production data or shared databases.

  **Trigger when user asks to:**
  - Test a schema migration before applying it to production
  - Add, remove, or rename columns safely on a live table
  - Change a column's data type without downtime
  - Add or drop indexes, constraints, or foreign keys on large tables
  - Understand which ALTER TABLE operations lock the table
  - Roll back a failed migration
  - Plan a zero-downtime migration strategy
  - Fork a database to test a migration safely

  **Keywords:** migration, schema change, ALTER TABLE, add column, drop column, rename column, change type, zero downtime, lock, AccessExclusiveLock, concurrent index, forking, ghost, rollback, backfill, deploy

  Covers: lock-level reference for every common DDL operation, safe migration patterns, fork-based testing, zero-downtime column changes, index creation, constraint addition, backfill strategies, pre/post-migration validation, and rollback planning.
---

# PostgreSQL Database Migrations

A schema migration that works on an empty dev database can fail, lock, or corrupt data on a production table with millions of rows. This guide covers how to assess risk, test against real data, and execute migrations safely.

## DDL Lock Reference

Every schema change acquires a lock. The critical question is: **does it block reads and writes, and for how long?**

### Fast, Non-Blocking Operations

These complete in milliseconds regardless of table size. They only hold a brief `AccessExclusiveLock` for the catalog update, not for data rewriting.

| Operation | Lock Level | Notes |
|-----------|-----------|-------|
| `ADD COLUMN` (nullable, no default) | `AccessExclusiveLock` (brief) | **Fast.** No table rewrite. Metadata-only change. |
| `ADD COLUMN ... DEFAULT x` (PG 11+) | `AccessExclusiveLock` (brief) | **Fast.** Non-volatile defaults stored in catalog, not backfilled. |
| `DROP COLUMN` | `AccessExclusiveLock` (brief) | **Fast.** Column marked invisible; space reclaimed by VACUUM over time. |
| `SET DEFAULT` / `DROP DEFAULT` | `AccessExclusiveLock` (brief) | Metadata change only. Does not touch existing rows. |
| `CREATE INDEX CONCURRENTLY` | `ShareUpdateExclusiveLock` | **Non-blocking.** Allows reads and writes during build. Slower than regular index creation. |
| `DROP INDEX CONCURRENTLY` | `ShareUpdateExclusiveLock` | **Non-blocking.** Waits for queries using the index to finish, then drops. No table-level exclusive lock. |
| `RENAME COLUMN` | `AccessExclusiveLock` (brief) | Metadata change only. Fast. |
| `RENAME TABLE` | `AccessExclusiveLock` (brief) | Metadata change only. Fast. |
| `ADD CONSTRAINT ... NOT VALID` | `ShareUpdateExclusiveLock` | Adds constraint for new rows only. Does not scan existing data. |
| `VALIDATE CONSTRAINT` | `ShareUpdateExclusiveLock` | Scans existing rows but allows concurrent reads and writes. |
| `CREATE/DROP TRIGGER` | `ShareRowExclusiveLock` | Brief catalog update. |

### Slow or Blocking Operations

These rewrite the table or scan all rows. On large tables, they can lock out all access for seconds to hours.

| Operation | Lock Level | Why It's Slow |
|-----------|-----------|---------------|
| `ADD COLUMN ... DEFAULT x` (volatile, e.g. `now()`, `gen_random_uuid()`) | `AccessExclusiveLock` | Full table rewrite. Every row gets the computed value. |
| `ALTER COLUMN TYPE` (most type changes) | `AccessExclusiveLock` | Full table rewrite to convert stored data. |
| `SET NOT NULL` (PG < 12, or without existing CHECK) | `AccessExclusiveLock` | Full table scan to verify no NULLs. See safe pattern below. |
| `ADD CONSTRAINT ... CHECK/UNIQUE/FK` (validated) | `AccessExclusiveLock` or `ShareRowExclusiveLock` | Scans all rows to verify, blocks writes. |
| `CREATE INDEX` (without CONCURRENTLY) | `ShareLock` | Blocks writes for the entire build duration. |
| `CLUSTER` | `AccessExclusiveLock` | Rewrites entire table in index order. |
| `VACUUM FULL` | `AccessExclusiveLock` | Rewrites table to reclaim space. |

**Key insight:** `AccessExclusiveLock` blocks everything — reads and writes. Even if the operation itself is fast (milliseconds), it must wait for all in-flight transactions to finish before acquiring the lock. A long-running query or idle transaction can cause an `ALTER TABLE` to hang and queue up all subsequent queries behind it.

## Safe Migration Patterns

### Add a Column

```sql
-- SAFE: nullable column, no default — instant
ALTER TABLE orders ADD COLUMN tracking_number TEXT;

-- SAFE (PG 11+): column with non-volatile default — instant
ALTER TABLE orders ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;

-- UNSAFE: column with volatile default — full table rewrite
-- DON'T: ALTER TABLE orders ADD COLUMN created_at TIMESTAMPTZ DEFAULT now();
-- DO: add nullable, then backfill, then set default + NOT NULL
ALTER TABLE orders ADD COLUMN created_at TIMESTAMPTZ;
-- Backfill in batches (see Backfill section)
ALTER TABLE orders ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE orders ALTER COLUMN created_at SET NOT NULL;  -- only if PG12+ or CHECK exists
```

### Drop a Column

```sql
-- SAFE: instant (column marked invisible, space reclaimed by VACUUM)
ALTER TABLE orders DROP COLUMN old_status;
```

**Application coordination:** Ensure your application no longer references the column before dropping it. For zero-downtime deploys, this requires two steps:
1. Deploy code that doesn't read/write the column
2. Then drop the column in a separate migration

**Security caveat:** `DROP COLUMN` does not physically delete the data. The column is marked as dropped in `pg_attribute` but the values remain on disk until `VACUUM` reclaims the space — and even then, a superuser could recover them. If the column contains sensitive data, run `VACUUM FULL` on the table after dropping, or use dump/restore to ensure the data is truly gone.

### Rename a Column

```sql
-- SAFE: instant metadata change
ALTER TABLE orders RENAME COLUMN status TO order_status;
```

**Warning:** This breaks any application code, views, or functions that reference the old column name. For zero-downtime deploys, use the column-swap pattern instead:
1. Add the new column
2. Deploy code that writes to both columns
3. Backfill old rows
4. Deploy code that reads from the new column
5. Drop the old column

### Change a Column Type

Most type changes rewrite the entire table. Safe alternatives:

```sql
-- UNSAFE: full table rewrite, blocks everything
-- DON'T: ALTER TABLE orders ALTER COLUMN amount TYPE NUMERIC(12,2);

-- SAFE: use a new column + backfill
ALTER TABLE orders ADD COLUMN amount_new NUMERIC(12,2);

-- Backfill in batches (see Backfill section below)
UPDATE orders SET amount_new = amount WHERE id BETWEEN 1 AND 10000;
-- ... continue in batches ...

-- Swap columns
ALTER TABLE orders DROP COLUMN amount;
ALTER TABLE orders RENAME COLUMN amount_new TO amount;
```

**Exception:** Some casts don't require a rewrite and are fast:

| From | To | Rewrite? |
|------|----|----------|
| `VARCHAR(n)` → `VARCHAR(m)` where m > n | No | Metadata only |
| `VARCHAR(n)` → `TEXT` | No | Metadata only |
| `NUMERIC(p,s)` → `NUMERIC(p2,s)` where p2 > p (same scale) | No | Metadata only |
| `INTEGER` → `BIGINT` | **Yes** | Full rewrite |
| `TIMESTAMP` → `TIMESTAMPTZ` | **Yes** | Full rewrite |

### Add a NOT NULL Constraint

```sql
-- PG 18+: simplified two-step pattern
ALTER TABLE orders ALTER COLUMN order_status SET NOT NULL NOT VALID;
ALTER TABLE orders VALIDATE NOT NULL ON order_status;

-- PG 12–17: fast if a valid CHECK constraint already exists
-- Step 1: add CHECK (non-blocking scan)
ALTER TABLE orders ADD CONSTRAINT orders_status_nn CHECK (order_status IS NOT NULL) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT orders_status_nn;

-- Step 2: add NOT NULL (PG12+ recognizes the CHECK and skips the scan)
ALTER TABLE orders ALTER COLUMN order_status SET NOT NULL;

-- Step 3: drop the now-redundant CHECK
ALTER TABLE orders DROP CONSTRAINT orders_status_nn;

-- PG < 12: SET NOT NULL always scans the full table.
-- Ensure no NULLs exist first, then accept the brief lock.
```

### Add a Foreign Key

```sql
-- UNSAFE: validates all existing rows while holding a heavy lock
-- DON'T: ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id);

-- SAFE: two-step approach
-- Step 1: add without validation (blocks writes briefly, doesn't scan data)
ALTER TABLE orders ADD CONSTRAINT fk_user
    FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID;

-- Step 2: validate existing rows (allows concurrent reads and writes)
ALTER TABLE orders VALIDATE CONSTRAINT fk_user;
```

### Add an Index

```sql
-- UNSAFE on large tables: blocks all writes for the entire build
-- DON'T: CREATE INDEX idx_orders_user ON orders (user_id);

-- SAFE: concurrent index creation (allows reads and writes)
CREATE INDEX CONCURRENTLY idx_orders_user ON orders (user_id);

-- IMPORTANT: if concurrent index creation fails (crashes, deadlock),
-- it leaves an INVALID index behind. Check and clean up:
SELECT indexrelname, idx_scan
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
  AND indexrelname = 'idx_orders_user';

-- Check for invalid indexes
SELECT indexrelid::regclass AS index_name, indisvalid
FROM pg_index
WHERE NOT indisvalid;

-- Drop and retry if invalid
DROP INDEX CONCURRENTLY idx_orders_user;
CREATE INDEX CONCURRENTLY idx_orders_user ON orders (user_id);
```

### Add a Unique Constraint

```sql
-- A UNIQUE constraint creates an index. Use CONCURRENTLY to avoid blocking:

-- Step 1: create a unique index concurrently
CREATE UNIQUE INDEX CONCURRENTLY idx_orders_tracking_uniq ON orders (tracking_number);

-- Step 2: attach it as a constraint (instant)
ALTER TABLE orders ADD CONSTRAINT orders_tracking_uniq UNIQUE USING INDEX idx_orders_tracking_uniq;
```

### Redefine a Primary Key

Redefining a PK (e.g., switching from `id` to a composite key, or from `int` to `bigint`) requires both a UNIQUE constraint and NOT NULL — both of which can cause long-lasting locks if done naively. The zero-downtime approach builds each ingredient separately:

```sql
-- Step 1: add CHECK NOT NULL constraint without validation (brief lock)
ALTER TABLE orders ADD CONSTRAINT orders_new_id_nn
    CHECK (new_id IS NOT NULL) NOT VALID;

-- Step 2: validate existing rows (allows concurrent reads and writes)
ALTER TABLE orders VALIDATE CONSTRAINT orders_new_id_nn;

-- Step 3: build unique index concurrently (non-blocking)
CREATE UNIQUE INDEX CONCURRENTLY idx_orders_new_pkey
    ON orders (new_id);

-- Step 4: drop the old PK
ALTER TABLE orders DROP CONSTRAINT orders_pkey;

-- Step 5: add new PK using the existing index (instant — also implicitly adds NOT NULL)
ALTER TABLE orders ADD CONSTRAINT orders_pkey
    PRIMARY KEY USING INDEX idx_orders_new_pkey;

-- Step 6: drop the now-redundant CHECK constraint
ALTER TABLE orders DROP CONSTRAINT orders_new_id_nn;
```

**Why this works:** Step 5 is fast because Postgres reuses the already-built unique index and recognizes the existing CHECK constraint, skipping both the index build and the full-table NOT NULL scan (PG12+).

### Drop a Constraint

```sql
-- SAFE: instant metadata change
ALTER TABLE orders DROP CONSTRAINT orders_tracking_uniq;

-- If dropping a FK that has a supporting index you no longer need:
ALTER TABLE orders DROP CONSTRAINT fk_user;
DROP INDEX idx_orders_user_id;  -- only if no other queries use it
```

## Backfill Strategies

Always backfill in batches — never in a single UPDATE. See [backfill-strategies](references/backfill-strategies.md) for batch-by-PK patterns, resumable progress tracking, and tuning guidance.

## Migration Validation

Run validation queries before and after every migration. See [validation-queries](references/validation-queries.md) for the full set of checks: NULL detection, duplicate detection, orphan rows, cast failures, duration estimation, schema verification, data integrity, and query performance.

## Rollback Planning

Every migration should have a rollback plan documented before execution.

### Reversible Operations

| Operation | Rollback |
|-----------|----------|
| `ADD COLUMN` | `DROP COLUMN` |
| `ADD CONSTRAINT` | `DROP CONSTRAINT` |
| `CREATE INDEX` | `DROP INDEX` |
| `RENAME COLUMN x TO y` | `RENAME COLUMN y TO x` |
| `SET DEFAULT x` | `SET DEFAULT old_value` or `DROP DEFAULT` |
| `ADD COLUMN new + DROP COLUMN old` | Cannot directly undo — need to re-add old column and backfill from a backup |

### Irreversible Operations

These require restoring from a backup or the database fork to undo:

- **`DROP COLUMN`** — data is gone once VACUUM reclaims it
- **`ALTER COLUMN TYPE`** with lossy cast (e.g., `NUMERIC` → `INTEGER`, `TEXT` → `VARCHAR(50)`)
- **`DELETE` / `TRUNCATE`** during data cleanup
- **`DROP TABLE`**

**This is where a database fork is invaluable.** If you forked before the migration, the original database has the pre-migration state. If the migration went wrong, your production data is untouched — just delete the fork and start over.

## Transaction Strategy

There are two approaches for executing multiple DDL statements. Each has tradeoffs:

**Wrapped in one transaction** — all changes succeed or all roll back. Use this when atomicity matters more than lock duration, and all operations are fast (milliseconds).

```sql
BEGIN;

ALTER TABLE orders ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN tags TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX ON orders USING GIN (tags);
ALTER TABLE orders DROP COLUMN old_priority;

-- Verify before committing
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'orders'
ORDER BY ordinal_position;

COMMIT;
-- Or ROLLBACK; if something looks wrong
```

**Separate transactions** — each DDL runs and commits independently. Use this when lock duration matters more than atomicity. In a single transaction, all locks are held until `COMMIT` — so if you have 5 DDL statements, the `AccessExclusiveLock` from the first one blocks traffic for the entire duration of all 5. Separate transactions release locks between statements.

```sql
-- Each statement auto-commits
ALTER TABLE orders ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE orders DROP COLUMN old_priority;
```

**The tradeoff:** separate transactions can leave the schema in a partially migrated state if a later statement fails. You'll need a rollback plan for each step individually.

**Cannot use transactions with:**
- `CREATE INDEX CONCURRENTLY` (explicitly disallowed inside a transaction)
- `DROP INDEX CONCURRENTLY`
- Any statement that requires its own transaction context

## Dealing with Long-Running Queries

A fast `ALTER TABLE` can still hang if it's waiting to acquire `AccessExclusiveLock` behind a long-running query. Worse, the waiting DDL blocks all subsequent queries too — even simple SELECTs pile up behind it:

```
Session 1: SELECT COUNT(*) FROM orders;          -- long query, holds AccessShareLock
Session 2: ALTER TABLE orders ADD COLUMN ...;     -- waits for Session 1 (needs AccessExclusiveLock)
Session 3: SELECT * FROM orders WHERE id = 123;   -- BLOCKED by Session 2's lock queue entry
Session 4: INSERT INTO orders (...) VALUES (...);  -- also BLOCKED
-- All sessions freeze until Session 1 finishes and Session 2 completes or times out
```

This is why `lock_timeout` is critical — without it, a single slow query can cascade into an application-wide outage.

### Set Timeouts

**`lock_timeout`** — How long to wait for a lock before giving up. Use this on every production DDL statement. Without it, an `ALTER TABLE` can queue behind a long-running query and block all subsequent queries behind it indefinitely.

**`statement_timeout`** — How long the statement can run once it has the lock. This is a safety net against unexpectedly slow operations (e.g., a type change that triggers a table rewrite you didn't anticipate). The tradeoff: if the timeout fires mid-operation, the entire statement rolls back — which is safe for DDL (no partial changes), but means a long `CREATE INDEX CONCURRENTLY` could be killed near completion. For that reason, avoid setting `statement_timeout` on operations you know will be slow (like concurrent index builds on large tables) and instead monitor them manually.

**Choosing timeout values:**

There are two schools of thought:

- **Conservative (50-100ms lock_timeout, hundreds of retries):** Minimizes the window where a waiting DDL blocks other queries. Each attempt is nearly invisible to application traffic, but requires retry logic. Best for high-traffic OLTP systems where even a few seconds of blocked queries is unacceptable.
- **Pragmatic (3-5s lock_timeout, few retries):** Gives the lock a reasonable chance to be acquired on each attempt, reducing the need for complex retry logic. Acceptable for most applications where brief pauses are tolerable.

Pick based on your traffic profile: the higher your query throughput, the shorter your `lock_timeout` should be — because even a brief queue-up affects more queries per second. For `statement_timeout`, set it to a generous multiple of what you expect the operation to take (e.g., 30s for metadata-only changes, minutes for VALIDATE CONSTRAINT on large tables, disabled for CREATE INDEX CONCURRENTLY).

```sql
-- Fail fast instead of blocking all queries behind you
SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE orders ADD COLUMN tracking_number TEXT;

-- If it fails with "canceling statement due to lock timeout":
-- 1. Find what's blocking
SELECT pid, state, query, now() - query_start AS duration
FROM pg_stat_activity
WHERE state != 'idle'
ORDER BY duration DESC;

-- 2. Wait for the blocker to finish, or cancel it if appropriate
-- SELECT pg_cancel_backend(<pid>);

-- 3. Retry the ALTER TABLE
SET lock_timeout = '5s';
ALTER TABLE orders ADD COLUMN tracking_number TEXT;

-- Reset timeouts when done
RESET lock_timeout;
RESET statement_timeout;
```

### The Retry-With-Timeout Pattern

For automated migration runners, wrap DDL in a retry loop with a short lock timeout:

```sql
DO $$
DECLARE
    max_attempts INTEGER := 5;
    attempt INTEGER := 1;
    success BOOLEAN := FALSE;
BEGIN
    WHILE attempt <= max_attempts AND NOT success LOOP
        BEGIN
            SET lock_timeout = '3s';
            -- Replace with your DDL statement
            ALTER TABLE orders ADD COLUMN tracking_number TEXT;
            success := TRUE;
            RAISE NOTICE 'DDL succeeded on attempt %', attempt;
        EXCEPTION
            WHEN lock_not_available THEN
                RAISE NOTICE 'Attempt % failed (lock not available), retrying...', attempt;
                PERFORM pg_sleep(2 * attempt);  -- linear backoff
                attempt := attempt + 1;
        END;
    END LOOP;

    IF NOT success THEN
        RAISE EXCEPTION 'DDL failed after % attempts', max_attempts;
    END IF;
END $$;
```

This prevents the migration from creating a pile-up of blocked queries behind it. Each attempt either succeeds quickly or gives up and lets normal traffic flow.

**Alternative: `NOWAIT`** — For the highest-traffic systems, use `LOCK TABLE ... NOWAIT` to test lock availability before running DDL. Unlike `lock_timeout`, `NOWAIT` fails instantly without ever entering the lock queue, so there is zero risk of cascading blocked queries. The tradeoff is more retries:

```sql
BEGIN;
LOCK TABLE orders IN ACCESS EXCLUSIVE MODE NOWAIT;
-- If we get here, we have the lock — run DDL
ALTER TABLE orders ADD COLUMN tracking_number TEXT;
COMMIT;
-- If LOCK fails with "could not obtain lock", retry after a short sleep
```

## Fork-Based Migration Testing

The safest way to test a migration is to run it against a copy of your actual database — same schema, same data, same edge cases. The only two providers that support fast database forking are [Neon](https://neon.tech) and [Ghost](https://ghost.build). Without database forking, you need to manually dump and restore your database, which can take a long time for large datasets.

### With Forking

1. **Fork your database** — create a full copy using your provider's fork feature (takes seconds)
2. **Inspect the current schema** on the fork to confirm it matches production
3. **Run your migration** on the fork
4. **Validate** — run your checks (see Pre/Post-Migration Validation sections above)
5. **If it worked:** apply the same migration to production
6. **If it failed:** delete the fork — your production database is untouched

This catches problems that never show up in empty test databases:
- Data that violates a new constraint
- Type casts that fail on real values
- Migrations that are fast on 100 rows but lock the table for minutes on 10 million
- Index creation that runs out of memory or disk space

**Limitation:** fork-based testing runs your migration in isolation — it won't catch issues caused by concurrent database traffic (e.g., lock contention under load, deadlocks with concurrent writes, or replication lag from heavy WAL generation). For most applications, fork-based testing is sufficient. For very high-uptime applications, use [PgDog](https://pgdog.dev)'s mirroring feature to replay production traffic against the fork — it reproduces queries byte-for-byte with realistic timing, and you can filter to DDL-only or DML-only and control exposure percentage to ramp up gradually.

### Without Forking

Create a test database from a backup or dump:

```bash
# Dump your production database
pg_dump -Fc my_app_db > backup.dump

# Restore into a test database
createdb migration_test
pg_restore -d migration_test backup.dump

# Or clone from a live database (requires downtime on source during copy)
createdb migration_test -T my_app_db
```

## Complete Migration Example

For a full end-to-end walkthrough (plan, fork, run, validate, apply, clean up), see [complete-example](references/complete-example.md).

## Advanced Considerations

**Subtransactions in PL/pgSQL retry loops:** The `BEGIN/EXCEPTION WHEN/END` block in the retry-with-timeout pattern creates implicit subtransactions. Under high write throughput, this can trigger SubtransSLRU contention on replicas — especially if the retry loop runs as a long-lived transaction with many attempts. If you see replica lag during retries, move the retry logic to the application layer (separate transactions per attempt) instead of using PL/pgSQL exception handling.

**Autovacuum can block VALIDATE CONSTRAINT:** `VALIDATE CONSTRAINT` acquires `ShareUpdateExclusiveLock`, which conflicts with autovacuum running in transaction ID wraparound prevention mode. If `VALIDATE` hangs unexpectedly, check `pg_stat_activity` for autovacuum processes on the same table. You may need to wait for wraparound-prevention autovacuum to finish — do not cancel it, as that can lead to data loss if the table approaches the XID wraparound limit.

## Common Pitfalls

1. **Testing migrations on empty tables** — a migration that runs in 1ms on an empty table can lock a 10M-row table for minutes. Always test against realistic data volumes.
2. **Forgetting `CONCURRENTLY` on index creation** — `CREATE INDEX` (without `CONCURRENTLY`) blocks all writes. On a table with active traffic, this causes downtime.
3. **Adding NOT NULL without the two-step pattern** — on large tables in PG < 12, `SET NOT NULL` scans every row while holding `AccessExclusiveLock`. Use the CHECK constraint pattern.
4. **No lock timeout** — a fast ALTER TABLE can block behind a long-running query, and every subsequent query stacks up behind it. Always `SET lock_timeout` for production DDL.
5. **Backfilling in one big transaction** — a single `UPDATE orders SET x = y` on 10M rows generates enormous WAL, bloats the table, and holds locks for the entire duration. Always batch.
6. **Leaving invalid indexes behind** — if `CREATE INDEX CONCURRENTLY` fails, it leaves an invisible invalid index that consumes space and slows writes. Check `pg_index.indisvalid` after every concurrent index operation.
7. **Dropping columns before updating application code** — in a running system, the old code still references the column. Deploy the code change first, then drop the column in a subsequent migration.
8. **Not checking replication lag** — large backfills generate heavy WAL. If you have read replicas, monitor `pg_stat_replication` during and after the migration.
9. **Assuming ALTER COLUMN TYPE is safe** — most type changes rewrite the entire table. Use the add-new-column + backfill + swap pattern for large tables.
