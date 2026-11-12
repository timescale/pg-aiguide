# Retries and Failures

## The queue owns durable retries

Provider and HTTP clients often retry within one call. Those retries are not a substitute for queue retries:

- one queue attempt may make several remote requests;
- a process crash loses in-memory retry state;
- queue attempts must survive deployment and worker restarts;
- operators need durable failure inspection.

Document both layers so attempt counts are not mistaken for exact provider request counts.

## Ordinary retryable failure

On a transient processing or write-back failure, match the current claim and preserve the job for a later claim:

```sql
UPDATE work_queue
SET last_error = left($3, 4096),
    visible_at = now() + $4::interval,
    updated_at = now()
WHERE id = $1
  AND outcome IS NULL
  AND claim_version = $2;
```

The attempt was spent at claim time. Choose retry delay using bounded exponential backoff with jitter. Persist the next visibility time so another process sees the same delay.

If the worker crashes before recording failure, the existing lease expiry becomes the retry time. This is why claims must establish the lease before external work.

## Rate limits

A provider-wide rate limit usually says little about the validity of an individual job. A useful policy is to refund the claim attempt and defer visibility by `Retry-After` or a bounded default:

```sql
UPDATE work_queue
SET attempts = greatest(attempts - 1, 0),
    visible_at = now() + $3::interval,
    updated_at = now()
WHERE id = $1
  AND outcome IS NULL
  AND claim_version = $2;
```

Deferring visibility matters as much as refunding the attempt. Resetting `visible_at` to now lets another worker immediately reclaim the row and amplify the throttle.

When many workers share one provider account, maintain a shared in-process/pool rate-limit gate so one `429` pauses new claims by sibling workers. The database delay protects released rows across processes, but it does not automatically stop another process from claiming different jobs. Cross-process provider throttling may require lower configured concurrency or an explicit database-backed provider gate; add that complexity only when measurements require it.

Not every rate limit deserves an attempt refund. If throttling is caused by a permanently invalid account tier or job-specific quota, terminal handling may be appropriate. Classify from the provider contract.

## Configuration faults

Wrong vector dimensions, invalid deployment configuration, revoked credentials, or an unreachable database may affect every job. Avoid rapidly consuming the entire queue's attempt budgets.

Possible policies:

- release/refund the batch and stop or back off the worker for deterministic configuration errors;
- retain attempts but apply worker-level exponential backoff for likely transient infrastructure errors;
- surface a safe operational error through a callback, metric, or process supervisor;
- require operator correction before explicit terminal retry.

A worker can be alive while ordinary jobs repeatedly fail. Monitor queue failures in addition to worker-loop exceptions.

## Attempt exhaustion

Do not set `outcome = 'failed'` immediately after recording the final attempt's error unless the current worker still owns the claim and intentionally declares it terminal. The general crash-safe rule is to sweep only after visibility expires:

```sql
UPDATE work_queue
SET outcome = 'failed',
    last_error = coalesce(last_error, 'exceeded max attempts'),
    updated_at = now()
WHERE outcome IS NULL
  AND visible_at <= now()
  AND attempts >= max_attempts;
```

This catches both recorded failures and workers that crashed during their final attempt. It avoids declaring failure while an unexpired final attempt may still succeed.

A sweep runs when workers continue polling. If all workers stop, expired jobs remain pending until another worker or maintenance process runs the sweep. Status documentation should make that timing clear.

## Terminal failures and explicit retry

Retain terminal failures long enough to diagnose them. List only failures that still represent the current unresolved source state:

```sql
SELECT q.*
FROM work_queue AS q
JOIN source_record AS s
  ON s.id = q.source_id
 AND s.content_version = q.source_version
WHERE q.outcome = 'failed'
  AND s.derived_value IS NULL
ORDER BY q.id
LIMIT $1;
```

Paginate operational listings by a stable key such as `id`, not offset.

After correcting the cause, reset selected current failures atomically:

```sql
UPDATE work_queue AS q
SET outcome = NULL,
    attempts = 0,
    last_error = NULL,
    visible_at = now(),
    claim_version = q.claim_version + 1,
    updated_at = now()
FROM source_record AS s
WHERE q.id = ANY($1::bigint[])
  AND q.outcome = 'failed'
  AND s.id = q.source_id
  AND s.content_version = q.source_version
  AND s.derived_value IS NULL
RETURNING q.id;
```

Advancing `claim_version` invalidates any stale administrative or worker action holding the old generation. Unknown, resolved, already-retried, pruned, and stale IDs should be reported as skipped rather than resurrected.

Bound retry batches. Do not implement an unbounded “retry all” update; page current failures and reset explicit IDs.

## Diagnostics and sensitive data

`last_error` is operational data and may contain:

- provider request identifiers;
- source fragments;
- URLs or hostnames;
- credentials accidentally included by a driver;
- tenant or user data.

Bound its size at write time, restrict who can query it, and redact before sending it to logs or telemetry. Prefer safe error codes plus restricted diagnostic detail. Do not put payloads or raw exceptions into metric labels.

## Retention and pruning

Delete terminal rows after a deliberate retention window:

```sql
DELETE FROM work_queue
WHERE outcome IS NOT NULL
  AND updated_at < now() - $1::interval;
```

Use a partial archive index on `updated_at WHERE outcome IS NOT NULL`. Prune in bounded batches if retention can remove many rows. An idle worker can prune opportunistically, but a scheduled maintenance path is useful when workers are intermittent.

Pruning removes diagnostics and job IDs used for deduplication. If long-term audit or remote-side-effect reconciliation is required, archive selected terminal facts elsewhere before deletion.
