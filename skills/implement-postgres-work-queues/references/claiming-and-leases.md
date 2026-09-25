# Claiming and Leases

## Claim in one bounded statement

A claim may return one item or a bounded batch. In both cases it must select, lock, mutate, and return the same bounded candidate set atomically. Use `LIMIT 1` for one item or a higher limit for a batch:

```sql
WITH candidate AS (
  SELECT q.id
  FROM work_queue AS q
  WHERE q.outcome IS NULL
    AND q.visible_at <= now()
    AND q.attempts < q.max_attempts
  ORDER BY q.visible_at, q.id
  FOR UPDATE SKIP LOCKED
  LIMIT $1
)
UPDATE work_queue AS q
SET attempts = q.attempts + 1,
    claim_version = q.claim_version + 1,
    visible_at = now() + $2::interval,
    updated_at = now()
FROM candidate AS c
WHERE q.id = c.id
RETURNING
  q.id,
  q.source_id,
  q.source_version,
  q.job_type,
  q.payload,
  q.claim_version,
  q.attempts;
```

`SKIP LOCKED` lets concurrent claimers ignore rows another transaction currently holds rather than block behind them. It does not provide crash recovery by itself; moving `visible_at` creates the durable lease.

Keep the transaction short:

1. Begin.
2. Run any exhausted-attempt sweep.
3. Run the claim statement.
4. Commit.
5. Only then call external systems.

A client library may run the single claim statement in autocommit. An explicit transaction is useful when the sweep and claim must be grouped or transaction-local timeouts are set. Do not leave the transaction open while processing returned rows.

## Sweep exhausted attempts

Attempts increment when claimed, so a worker crash consumes an attempt. A row on its last attempt must remain pending until its lease expires: the original worker may still be running successfully.

Before claiming, finalize expired rows whose attempt budget is exhausted:

```sql
UPDATE work_queue
SET outcome = 'failed',
    last_error = coalesce(last_error, 'exceeded max attempts'),
    updated_at = now()
WHERE outcome IS NULL
  AND visible_at <= now()
  AND attempts >= max_attempts;
```

This sweep also catches a process that crashed after its final claim and never recorded an error. Do not mark `attempts >= max_attempts` rows failed while `visible_at > now()`.

The sweep and claim can be separate statements in one short transaction or CTEs in one statement. Keep both bounded enough for the workload. On a very large expired backlog, sweep in batches to avoid a long update transaction.

## Cancel stale candidates at claim

For derived work, avoid spending provider capacity on obsolete jobs. Lock a bounded candidate set, join it to the source, cancel missing/mismatched rows, and lease only current rows. A representative shape is:

```sql
WITH candidate AS (
  SELECT q.id
  FROM work_queue AS q
  WHERE q.outcome IS NULL
    AND q.visible_at <= now()
    AND q.attempts < q.max_attempts
  ORDER BY q.visible_at, q.id
  FOR UPDATE SKIP LOCKED
  LIMIT $1
),
current_job AS (
  SELECT
    q.id,
    q.source_id,
    q.source_version,
    s.content,
    s.content_version AS current_version
  FROM candidate AS c
  JOIN work_queue AS q ON q.id = c.id
  LEFT JOIN source_record AS s ON s.id = q.source_id
),
cancelled AS (
  UPDATE work_queue AS q
  SET outcome = 'cancelled', updated_at = now()
  FROM current_job AS j
  WHERE q.id = j.id
    AND (j.content IS NULL OR j.current_version IS DISTINCT FROM j.source_version)
  RETURNING q.id
),
claimed AS (
  UPDATE work_queue AS q
  SET attempts = q.attempts + 1,
      claim_version = q.claim_version + 1,
      visible_at = now() + $2::interval,
      updated_at = now()
  FROM current_job AS j
  WHERE q.id = j.id
    AND j.content IS NOT NULL
    AND j.current_version IS NOT DISTINCT FROM j.source_version
  RETURNING q.*, j.content
)
SELECT * FROM claimed ORDER BY id;
```

A foreign key with `ON DELETE CASCADE` may remove a deleted source's jobs before this query sees them. The left join still documents and defends the missing-source case for schemas without a cascade or with concurrent lifecycle changes.

If a claim consists entirely of stale candidates, claim again immediately so obsolete rows at the front do not make the worker appear idle.

## Lease sizing

Size the lease for the complete claimed unit—one item or a batch—not merely one remote request:

- input loading and transformation;
- tokenization or media preparation;
- provider queueing and latency;
- retries performed inside the provider SDK;
- local result validation;
- database write-back for the claimed item or whole batch.

A lease that is too short causes unnecessary duplicate execution. A lease that is too long delays crash recovery. Measure high-percentile duration for the complete claimed unit under realistic failure and throttling conditions, then leave margin.

A fixed lease is simpler and often sufficient. Lease renewal adds another state transition and failure mode. Add heartbeats only for genuinely long, observable jobs where a safe fixed upper bound is impractical; renew with the current `claim_version` so an expired worker cannot extend a newer claim.

## Claim generations

Every claim increments `claim_version` and returns it to the worker. Completion, failure recording, release, and lease renewal should match both job ID and claim version.

Without this fence:

1. Worker A claims generation 1.
2. Its lease expires while it is still working.
3. Worker B reclaims the row.
4. Worker A finishes and marks Worker B's active job completed.

For idempotent derived work, source-version fencing and terminal-row checks reduce harm, but a claim generation makes ownership explicit and is the safer generic default.

## Concurrency properties

With independent database connections:

- row locks prevent two transactions from claiming the same generation;
- `SKIP LOCKED` lets each transaction find other eligible rows;
- commit releases row locks, but the future `visible_at` keeps jobs hidden;
- lease expiry permits a new generation and therefore at-least-once execution;
- deterministic ordering improves predictability, but concurrent workers need not complete jobs in queue order.

Do not use queue order as a strict business-order guarantee. If jobs for one entity must run serially, design an explicit per-entity sequencing or advisory-lock policy and analyze crash recovery separately.

## Transaction time

`now()` is the transaction start timestamp. That is desirable in a short claim transaction because all rows receive one consistent lease deadline. Long claim transactions are already an anti-pattern. Use `clock_timestamp()` only when wall-clock movement within one transaction is intentionally required.

## Database timeouts

Workers should use bounded `statement_timeout`, `lock_timeout`, and, where supported, `transaction_timeout` or `idle_in_transaction_session_timeout`. A stuck claim must not become an indefinitely open transaction. Apply settings transaction-locally so a pooled connection does not leak worker-specific configuration to callers.
