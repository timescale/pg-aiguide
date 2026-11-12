# Completion and Fencing

Queue completion has two independent correctness questions:

1. **Does this worker still own the current claim generation?**
2. **Does the result still describe the current business/source state?**

Use a claim fence for the first and a source-version fence for the second.

## Claim-generation fence

Every mutation made by a worker after claiming should match the returned generation:

```sql
UPDATE work_queue
SET outcome = 'completed',
    updated_at = now()
WHERE id = $1
  AND outcome IS NULL
  AND claim_version = $2;
```

Treat zero updated rows as a normal lost-race result, not permission to retry the same completion without a fence. The job may have expired, been reclaimed, cancelled, completed, or deleted.

A random lease token can serve the same purpose, but a monotonically increasing integer is easy to inspect and requires no token-generation extension. Do not use only a worker ID: one worker can claim the same row more than once over time.

## Source-version fence

Suppose a job embeds or derives a value from `source_record.content` at `content_version = 7`. While the provider runs, an application changes the content to version 8. Generation 7 must not overwrite the result for version 8.

Write the result only while the source still has the queued version:

```sql
UPDATE source_record
SET derived_value = $3
WHERE id = $1
  AND content_version = $2;
```

The source version should advance for every input change that can alter the derived result. It need not be the record's public optimistic-lock version if embedding-only or maintenance updates have different lifecycle semantics.

## Atomic write-back and finalization

Install the result and finalize the queue row in one statement/transaction:

```sql
WITH active AS (
  SELECT source_id, source_version
  FROM work_queue
  WHERE id = $1
    AND outcome IS NULL
    AND claim_version = $2
  FOR UPDATE
),
written AS (
  UPDATE source_record AS s
  SET derived_value = $3
  FROM active AS a
  WHERE s.id = a.source_id
    AND s.content_version = a.source_version
  RETURNING s.id
),
finalized AS (
  UPDATE work_queue AS q
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

The queue-row lock serializes finalization for the current generation. The source predicate rejects stale results. If the claim is no longer current, `finalized` returns no row; if the claim is current but the source changed or disappeared, it returns `cancelled`.

Do not update the same queue tuple in multiple data-modifying CTEs in one statement. Select/lock it first, update the source from that CTE, and update the queue once.

## Directly supplied results

A caller may write a precomputed result while an older job is pending or leased. Advance the source fence when the directly supplied value changes, even if the source content itself did not. The pending job then fails its source-version check and is cancelled rather than overwriting the supplied value.

Whether installing an asynchronously generated result itself advances the source fence is domain-specific. If it does, ensure the write-back predicate checks the pre-update version and that the result update does not enqueue itself recursively.

## Remote side effects

A database claim fence cannot retract a remote action already performed by an expired worker. For email, webhook, payment, or API mutation jobs:

- derive a stable idempotency key from the durable job ID, not the claim generation;
- send it to the downstream API when supported;
- keep the same key across retries and lease generations;
- enforce uniqueness in a receiver you control;
- record the downstream operation ID when useful for reconciliation.

The remaining unavoidable window is:

```text
remote side effect succeeds
→ worker crashes before database completion
→ job is retried
```

Only downstream idempotency or reconciliation can resolve this window. Do not market the queue as exactly once.

## Immutable-payload jobs

Not every job derives from mutable source data. If `payload` is the immutable authoritative input, source-version fencing may be unnecessary. Claim-generation fencing and downstream idempotency still apply.

For jobs whose desired effect changes with source state, decide explicitly whether old jobs should:

- be cancelled as stale;
- execute using their immutable historical payload; or
- be coalesced into the newest desired state.

Do not infer this policy accidentally from table shape.

## Batch result handling

Providers may return partial results or results out of order. Associate every result with a stable queue/source ID rather than relying solely on array position unless the provider contract guarantees positional correspondence and code validates result count.

Finalize rows independently when one row's database write-back can fail without invalidating others. A batch-level permanent fault, such as an invalid model dimension, may require releasing the whole batch and surfacing a worker configuration error rather than consuming every job's attempts.

## Cancellation is not failure

Use `cancelled` for obsolete work:

- source row deleted;
- source version changed;
- a direct/precomputed result superseded the job;
- business state says the requested derivation is no longer needed.

Cancellation should not page operators as a provider failure. Track it separately because a sudden high cancellation rate can still indicate excessive source churn or undersized worker capacity.
