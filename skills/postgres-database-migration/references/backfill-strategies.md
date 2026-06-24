# Backfill Strategies

Backfilling (updating existing rows to populate a new column) on large tables must be done in batches to avoid long-running transactions, excessive locking, and WAL bloat.

## Batch by Primary Key

```sql
-- Backfill in chunks of 10,000 rows
-- Run this repeatedly until 0 rows affected
WITH batch AS (
    SELECT id FROM orders
    WHERE amount_new IS NULL
    ORDER BY id
    LIMIT 10000
    FOR UPDATE SKIP LOCKED
)
UPDATE orders
SET amount_new = amount::NUMERIC(12,2)
WHERE id IN (SELECT id FROM batch);
```

## Batch with Progress Tracking

```sql
-- Create a tracking table to resume if interrupted
CREATE TABLE migration_progress (
    migration_name TEXT PRIMARY KEY,
    last_processed_id BIGINT NOT NULL DEFAULT 0,
    rows_updated BIGINT NOT NULL DEFAULT 0,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO migration_progress (migration_name) VALUES ('backfill_amount_new');

-- Run in a loop (from application code or script):
DO $$
DECLARE
    v_batch_size CONSTANT INTEGER := 10000;
    v_last_id BIGINT;
    v_rows INTEGER;
BEGIN
    SELECT last_processed_id INTO v_last_id
    FROM migration_progress WHERE migration_name = 'backfill_amount_new';

    LOOP
        UPDATE orders
        SET amount_new = amount::NUMERIC(12,2)
        WHERE id > v_last_id AND id <= v_last_id + v_batch_size
          AND amount_new IS NULL;

        GET DIAGNOSTICS v_rows = ROW_COUNT;
        EXIT WHEN v_rows = 0;

        v_last_id := v_last_id + v_batch_size;

        UPDATE migration_progress
        SET last_processed_id = v_last_id,
            rows_updated = rows_updated + v_rows,
            updated_at = now()
        WHERE migration_name = 'backfill_amount_new';

        COMMIT;
        -- Yields to other transactions between batches
        PERFORM pg_sleep(0.1);
    END LOOP;
END;
$$;
```

## Backfill Considerations

- **Batch size:** Start with 10,000. Increase if each batch completes in under 1 second; decrease if it causes lock contention.
- **Sleep between batches:** 50–200ms gives other queries room. Tune based on your write load.
- **Monitor replication lag:** If you have replicas, check that the backfill doesn't cause them to fall behind.
- **VACUUM:** Run `VACUUM` (not `VACUUM FULL`) after a large backfill to reclaim dead tuple space without locking the table.
