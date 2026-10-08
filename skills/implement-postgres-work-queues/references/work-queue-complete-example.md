# Complete Work Queue Example

This example processes a derived value for mutable documents. It demonstrates the queue state machine and transaction boundaries; adapt names, permissions, error policy, and result type to the application.

## Guarantees and assumptions

- Delivery is at least once.
- One job exists per document content version.
- `visible_at` is both the claim lease deadline and next retry eligibility time.
- `claim_version` fences expired workers.
- `content_version` fences stale derived results.
- External processing happens outside database transactions.
- Workers poll; the design does not use `LISTEN`/`NOTIFY`.

## Tables and indexes

```sql
CREATE TABLE document (
  id UUID PRIMARY KEY,
  content TEXT NOT NULL,
  content_version INTEGER NOT NULL DEFAULT 1 CHECK (content_version > 0),
  derived_value JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE document_work_queue (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  content_version INTEGER NOT NULL CHECK (content_version > 0),
  visible_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claim_version BIGINT NOT NULL DEFAULT 0 CHECK (claim_version >= 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  outcome TEXT CHECK (
    outcome IS NULL OR outcome IN ('completed', 'failed', 'cancelled')
  ),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, content_version)
);

CREATE INDEX document_work_queue_claim_idx
ON document_work_queue (visible_at, id)
WHERE outcome IS NULL;

CREATE INDEX document_work_queue_document_pending_idx
ON document_work_queue (document_id, content_version DESC)
WHERE outcome IS NULL;

CREATE INDEX document_work_queue_archive_idx
ON document_work_queue (updated_at)
WHERE outcome IS NOT NULL;

-- Needed for efficient FK checks and ON DELETE CASCADE over all queue states.
CREATE INDEX document_work_queue_document_id_idx
ON document_work_queue (document_id);
```

## Maintain the source version

```sql
CREATE FUNCTION document_maintain_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF OLD.content IS DISTINCT FROM NEW.content THEN
    NEW.content_version := OLD.content_version + 1;
    NEW.derived_value := NULL;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

CREATE TRIGGER document_maintain_version
BEFORE UPDATE ON document
FOR EACH ROW
EXECUTE FUNCTION document_maintain_version();
```

A production table may separate public record versioning from the narrower version fence used for derived work. Advance this fence for every input change that invalidates the result.

## Enqueue from all writers

```sql
CREATE FUNCTION document_enqueue_work()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  INSERT INTO public.document_work_queue (document_id, content_version)
  VALUES (NEW.id, NEW.content_version);
  RETURN NEW;
END;
$function$;

CREATE TRIGGER document_enqueue_insert
AFTER INSERT ON document
FOR EACH ROW
WHEN (NEW.derived_value IS NULL)
EXECUTE FUNCTION document_enqueue_work();

CREATE TRIGGER document_enqueue_update
AFTER UPDATE OF content ON document
FOR EACH ROW
WHEN (
  OLD.content IS DISTINCT FROM NEW.content
  AND NEW.derived_value IS NULL
)
EXECUTE FUNCTION document_enqueue_work();
```

An insert supplying `derived_value` skips enqueueing. A content update clears the old result, advances `content_version`, and enqueues the new version in the same transaction.

## Sweep expired final attempts

Run before a claim:

```sql
UPDATE document_work_queue
SET outcome = 'failed',
    last_error = coalesce(last_error, 'exceeded max attempts'),
    updated_at = now()
WHERE outcome IS NULL
  AND visible_at <= now()
  AND attempts >= max_attempts;
```

For a very large exhausted backlog, select and update a bounded locked set rather than sweeping every row in one transaction.

## Claim current work

Run this in a short transaction. `$1` is the claim limit and `$2` is lease duration. Pass `1` to claim one item or a higher bounded value to claim a batch.

```sql
WITH candidate AS (
  SELECT q.id
  FROM document_work_queue AS q
  WHERE q.outcome IS NULL
    AND q.visible_at <= now()
    AND q.attempts < q.max_attempts
  ORDER BY q.visible_at, q.id
  FOR UPDATE SKIP LOCKED
  LIMIT $1
),
joined AS (
  SELECT
    q.id,
    q.document_id,
    q.content_version,
    d.content,
    d.content_version AS current_version
  FROM candidate AS c
  JOIN document_work_queue AS q ON q.id = c.id
  LEFT JOIN document AS d ON d.id = q.document_id
),
cancelled AS (
  UPDATE document_work_queue AS q
  SET outcome = 'cancelled', updated_at = now()
  FROM joined AS j
  WHERE q.id = j.id
    AND (j.content IS NULL OR j.current_version IS DISTINCT FROM j.content_version)
  RETURNING q.id
),
claimed AS (
  UPDATE document_work_queue AS q
  SET attempts = q.attempts + 1,
      claim_version = q.claim_version + 1,
      visible_at = now() + $2::interval,
      updated_at = now()
  FROM joined AS j
  WHERE q.id = j.id
    AND j.content IS NOT NULL
    AND j.current_version IS NOT DISTINCT FROM j.content_version
  RETURNING
    q.id AS queue_id,
    q.document_id,
    q.content_version,
    q.claim_version,
    j.content
)
SELECT * FROM claimed ORDER BY queue_id;
```

Commit now. Do not call the external derivation provider before commit.

If no jobs are returned but candidates were cancelled, claim again immediately. Otherwise obsolete rows at the head can cause an unnecessary idle sleep.

## Perform external work

Language-neutral pseudocode:

```text
jobs = claim(claim_limit, lease_duration) // use 1 for one item; transaction commits here
if jobs is empty:
  sleep idle interval
  return

try:
  results = provider.process(jobs.content) // no DB transaction is open
catch rate_limit:
  for job in jobs:
    release_and_refund(job.queue_id, job.claim_version, retry_after)
  pause provider gate
  return
catch configuration_fault:
  for job in jobs:
    release_and_refund(job.queue_id, job.claim_version, short_delay)
  report and back off worker
  return
catch ordinary_failure as error:
  for job in jobs:
    record_retry(job.queue_id, job.claim_version, error, retry_delay)
  return

for job in jobs:
  complete(job, results[job.queue_id])
```

Associate results by durable ID. Validate result count, type, dimensions, and other invariants before write-back.

## Complete with both fences

`$1` is queue ID, `$2` is claim version, and `$3` is the JSON result:

```sql
WITH active AS (
  SELECT document_id, content_version
  FROM document_work_queue
  WHERE id = $1
    AND outcome IS NULL
    AND claim_version = $2
  FOR UPDATE
),
written AS (
  UPDATE document AS d
  SET derived_value = $3::jsonb
  FROM active AS a
  WHERE d.id = a.document_id
    AND d.content_version = a.content_version
  RETURNING d.id
),
finalized AS (
  UPDATE document_work_queue AS q
  SET outcome = CASE
        WHEN EXISTS (SELECT 1 FROM written) THEN 'completed'
        ELSE 'cancelled'
      END,
      updated_at = now()
  WHERE q.id = $1
    AND q.outcome IS NULL
    AND q.claim_version = $2
  RETURNING q.outcome
)
SELECT outcome FROM finalized;
```

No returned row means the claim generation lost ownership or the queue row disappeared. `cancelled` means the claim was current but its source version was no longer current.

The document's version trigger does not advance `content_version` for a `derived_value`-only update, so asynchronous maintenance does not invalidate itself.

## Record an ordinary failure

```sql
UPDATE document_work_queue
SET last_error = left($3, 4096),
    visible_at = now() + $4::interval,
    updated_at = now()
WHERE id = $1
  AND outcome IS NULL
  AND claim_version = $2;
```

Attempts are not refunded. If this update never occurs because the worker crashes, the claim lease already provides a retry deadline.

## Release a rate-limited or misconfigured batch

```sql
UPDATE document_work_queue
SET attempts = greatest(attempts - 1, 0),
    visible_at = now() + $3::interval,
    updated_at = now()
WHERE id = $1
  AND outcome IS NULL
  AND claim_version = $2;
```

Use the provider's `Retry-After` when available. A zero delay can preserve work after a corrected configuration, but the worker itself must back off to avoid a hot loop.

## Queue status

```sql
SELECT
  count(*) FILTER (WHERE outcome IS NULL) AS pending,
  count(*) FILTER (
    WHERE outcome IS NULL AND visible_at <= now() AND attempts < max_attempts
  ) AS waiting,
  count(*) FILTER (
    WHERE outcome IS NULL AND visible_at > now()
  ) AS hidden,
  count(*) FILTER (
    WHERE outcome = 'failed'
      AND EXISTS (
        SELECT 1
        FROM document AS d
        WHERE d.id = document_work_queue.document_id
          AND d.content_version = document_work_queue.content_version
          AND d.derived_value IS NULL
      )
  ) AS current_failed,
  min(created_at) FILTER (WHERE outcome IS NULL) AS oldest_pending_at
FROM document_work_queue;
```

`hidden` is not synonymous with an active provider call. It includes retry delays and abandoned but unexpired leases.

## Inspect and retry current failures

```sql
SELECT q.*
FROM document_work_queue AS q
JOIN document AS d
  ON d.id = q.document_id
 AND d.content_version = q.content_version
WHERE q.outcome = 'failed'
  AND d.derived_value IS NULL
  AND q.id > $1
ORDER BY q.id
LIMIT $2;
```

Reset explicit, bounded IDs after correcting the underlying cause:

```sql
UPDATE document_work_queue AS q
SET outcome = NULL,
    attempts = 0,
    last_error = NULL,
    visible_at = now(),
    claim_version = q.claim_version + 1,
    updated_at = now()
FROM document AS d
WHERE q.id = ANY($1::bigint[])
  AND q.outcome = 'failed'
  AND d.id = q.document_id
  AND d.content_version = q.content_version
  AND d.derived_value IS NULL
RETURNING q.id;
```

Compare returned IDs with requested IDs and report the remainder as skipped.

## Prune terminal history

```sql
DELETE FROM document_work_queue
WHERE outcome IS NOT NULL
  AND updated_at < now() - $1::interval;
```

Use bounded deletion for high-volume queues. Pruning deletes diagnostics and may remove durable deduplication history, so choose retention deliberately.

## Failure walkthrough

- **Worker crashes before claim commit:** row locks and updates roll back; work remains visible.
- **Worker crashes after claim:** `visible_at` eventually expires and another generation claims the row.
- **Document changes during processing:** completion cannot update the new version and marks the old job cancelled.
- **Old worker finishes after reclaim:** its `claim_version` no longer matches, so it cannot finalize.
- **Provider fails:** error is recorded and the row becomes visible after retry delay.
- **Provider rate-limits:** attempt is refunded and visibility is deferred through the throttle window.
- **Worker crashes on final attempt:** the row becomes visible after lease expiry; the next sweep marks it failed.
- **Remote effect succeeds before a crash:** the database cannot know; use the queue ID as a downstream idempotency key.
