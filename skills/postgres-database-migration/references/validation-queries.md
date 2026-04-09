# Migration Validation Queries

## Pre-Migration Validation

Run these checks **before** applying a migration. On a database fork, you can run them against real production data without any risk.

### Check for NULLs Before Adding NOT NULL

```sql
-- Will the NOT NULL constraint fail?
SELECT COUNT(*) AS null_count
FROM orders
WHERE order_status IS NULL;

-- Find sample rows to understand why they're NULL
SELECT id, created_at
FROM orders
WHERE order_status IS NULL
LIMIT 20;
```

### Check for Duplicates Before Adding UNIQUE

```sql
-- Will a UNIQUE constraint fail?
SELECT tracking_number, COUNT(*) AS occurrences
FROM orders
WHERE tracking_number IS NOT NULL
GROUP BY tracking_number
HAVING COUNT(*) > 1
ORDER BY occurrences DESC
LIMIT 20;
```

### Check for Orphans Before Adding a Foreign Key

```sql
-- Will a FK constraint fail?
SELECT o.id, o.user_id
FROM orders o
LEFT JOIN users u ON o.user_id = u.id
WHERE u.id IS NULL AND o.user_id IS NOT NULL
LIMIT 20;
```

### Check for Cast Failures Before Changing Type

```sql
-- Will the type change fail on any existing values?
SELECT id, amount
FROM orders
WHERE amount IS NOT NULL
  AND NOT (amount::TEXT ~ '^\d+(\.\d{1,2})?$');

-- Or try the cast and catch failures
SELECT id, amount
FROM orders
WHERE pg_typeof(amount) != 'numeric'
  AND amount IS NOT NULL;
```

### Estimate Migration Duration

```sql
-- Table size and row count (estimate for planning)
SELECT
    pg_size_pretty(pg_total_relation_size('orders')) AS total_size,
    pg_size_pretty(pg_relation_size('orders')) AS data_size,
    reltuples::BIGINT AS estimated_rows
FROM pg_class
WHERE relname = 'orders';

-- Estimate backfill time: run a small batch and extrapolate
-- WARNING: EXPLAIN ANALYZE actually executes the statement — this WILL update rows.
-- Run this on a fork, or wrap in a transaction and ROLLBACK after.
BEGIN;
EXPLAIN ANALYZE
UPDATE orders SET amount_new = amount::NUMERIC(12,2)
WHERE id BETWEEN 1 AND 1000 AND amount_new IS NULL;
-- If 1,000 rows takes 50ms and you have 10M rows → ~500s total
ROLLBACK;
```

## Post-Migration Validation

Run these **after** the migration to confirm it worked correctly.

### Schema Verification

```sql
-- Verify column was added/changed
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'orders' AND column_name = 'amount';

-- Verify constraint exists
SELECT conname, contype, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'orders'::regclass;

-- Verify index exists and is valid
SELECT indexrelid::regclass AS index_name,
       indisvalid AS is_valid,
       indisunique AS is_unique,
       pg_get_indexdef(indexrelid) AS definition
FROM pg_index
WHERE indrelid = 'orders'::regclass;
```

### Data Integrity

```sql
-- Verify backfill completed (no NULLs remaining)
SELECT COUNT(*) AS remaining_nulls
FROM orders
WHERE amount_new IS NULL AND amount IS NOT NULL;

-- Verify no data was lost
SELECT
    COUNT(*) AS total_rows,
    COUNT(amount) AS old_column_non_null,
    COUNT(amount_new) AS new_column_non_null
FROM orders;

-- Spot-check: old and new values match
SELECT id, amount AS old_value, amount_new AS new_value
FROM orders
WHERE amount::NUMERIC(12,2) != amount_new
LIMIT 10;
```

### Query Performance

```sql
-- Verify the new index is being used
EXPLAIN ANALYZE
SELECT * FROM orders WHERE user_id = 12345;

-- Check for sequential scans on the migrated table
SELECT relname, seq_scan, idx_scan
FROM pg_stat_user_tables
WHERE relname = 'orders';
```
