# Complete Migration Example

End-to-end example: adding a `status` column with a default, a NOT NULL constraint, and an index to a large table.

## Step 1: Plan and Document

```
Migration: Add order_status column to orders table
- Table: orders (~5M rows, 2 GB)
- Change: Add TEXT column with default 'pending', NOT NULL, partial index
- Risk: Low (no rewrite needed on PG 11+)
- Rollback: DROP COLUMN order_status
- Estimated duration: < 1 second for DDL, ~5 minutes for index build
```

## Step 2: Test on a Fork

Fork your database using your provider's fork feature (Neon, Ghost, or dump/restore).

## Step 3: Run on Fork

```sql
-- Fast: non-volatile default, no rewrite (PG 11+)
ALTER TABLE orders ADD COLUMN order_status TEXT NOT NULL DEFAULT 'pending';

-- Non-blocking index
CREATE INDEX CONCURRENTLY idx_orders_active
    ON orders (order_status, created_at DESC)
    WHERE order_status NOT IN ('completed', 'cancelled');
```

## Step 4: Validate on Fork

```sql
-- Column exists with correct type
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'orders' AND column_name = 'order_status';

-- All existing rows have the default
SELECT order_status, COUNT(*) FROM orders GROUP BY order_status;

-- Index is valid and used
EXPLAIN ANALYZE
SELECT * FROM orders WHERE order_status = 'pending' ORDER BY created_at DESC LIMIT 10;
```

## Step 5: Apply to Production

```sql
-- Set timeouts to avoid blocking traffic
SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE orders ADD COLUMN order_status TEXT NOT NULL DEFAULT 'pending';

RESET lock_timeout;
RESET statement_timeout;

-- Index creation is non-blocking, safe to run anytime
CREATE INDEX CONCURRENTLY idx_orders_active
    ON orders (order_status, created_at DESC)
    WHERE order_status NOT IN ('completed', 'cancelled');

-- Verify index is valid (not left in INVALID state)
SELECT indexrelid::regclass, indisvalid
FROM pg_index
WHERE indrelid = 'orders'::regclass AND NOT indisvalid;
```

## Step 6: Clean Up

Delete the test fork if you created one.
