# Worker Operation and Observability

## Adaptive polling loop

A worker should process immediately while work exists and sleep only after an idle claim:

```text
while not stopping:
  honor provider-wide backoff gate
  sweep expired exhausted jobs
  claim one item or a bounded batch in a short transaction
  if stale rows were cancelled but nothing was claimed:
    continue immediately
  if nothing was claimed:
    prune terminal rows opportunistically
    sleep(idle_interval, abort_signal)
    continue
  perform external work outside a transaction
  finalize each result with claim and source fences
```

This gives low latency during sustained ingestion without notifications. Make idle sleep abortable so shutdown does not wait for the full poll interval.

Do not add `LISTEN`/`NOTIFY` as a wake-up optimization. PostgreSQL notification publication requires shared commit-path coordination at cluster scope; a busy notification workload can serialize commit work that would otherwise proceed independently. Polling keeps queue latency an explicit worker setting and avoids coupling producer commits to notification delivery.

## Bounded drain pass

In addition to a continuous worker, expose a bounded drain operation for cron, serverless, tests, and bulk ingestion. Useful bounds include:

- maximum batches;
- wall-clock deadline checked between batches;
- cancellation signal checked before each claim;
- fixed batch size clamped to provider limits.

Cancellation is cooperative. Once external work starts, cancellation must not imply that a remote side effect or database mutation was rolled back.

## Graceful shutdown

A safe stop sequence:

1. Set a stop signal.
2. Interrupt idle sleep.
3. Do not claim another item or batch.
4. Let the current external call and write-back finish, subject to the process's overall shutdown deadline.
5. Close only resources the worker owns.

If the process is forcibly terminated, leases recover claimed rows. Never promise that forced shutdown rolls back an already-started remote operation.

## Backoff behavior

Use different controls for different failure scopes:

- **Empty queue:** fixed idle polling delay.
- **Ordinary per-job failure:** persisted job retry delay.
- **Rate limit:** provider `Retry-After` or bounded fallback; refund attempts when policy allows.
- **Worker-loop/database/configuration error:** bounded exponential backoff, usually with jitter.

Reset consecutive worker-loop errors after a successful pass. A rate limit need not increment that counter if it has its own gate and delay.

A callback or logger failure must not crash the worker. Conversely, do not silently swallow worker-loop failures: provide a safe reporting channel and metrics.

## Queue metrics

At minimum report:

```sql
SELECT
  count(*) FILTER (WHERE outcome IS NULL) AS pending,
  count(*) FILTER (
    WHERE outcome IS NULL AND visible_at <= now() AND attempts < max_attempts
  ) AS waiting,
  count(*) FILTER (
    WHERE outcome IS NULL AND visible_at > now()
  ) AS hidden,
  count(*) FILTER (WHERE outcome = 'failed') AS failed,
  count(*) FILTER (WHERE outcome = 'cancelled') AS cancelled,
  min(created_at) FILTER (WHERE outcome IS NULL) AS oldest_pending_at
FROM work_queue;
```

Call `visible_at > now()` **hidden**, leased, or unavailable—not definitely active. It includes active claims, crash leases that have not expired, ordinary retry delays, and rate-limit delays.

Useful additional telemetry:

- claims, completions, cancellations, and failures per interval;
- claim and end-to-end duration distributions;
- provider latency and rate-limit counts;
- attempts per completed job;
- stale-cancellation ratio;
- terminal retry and prune counts;
- worker-loop consecutive errors;
- queue table and index sizes;
- dead tuples and autovacuum activity.

Do not attach payloads, vectors, credentials, raw errors, or high-cardinality job IDs to unrestricted metrics.

## Alert on age, not only depth

Queue depth depends on arrival rate and claim size. A small queue containing one permanently stuck old job can be more important than a short healthy burst of thousands.

Alert on combinations such as:

- oldest pending age above the service objective;
- pending age rising for several intervals;
- terminal failures above zero or increasing;
- no completions while producers continue enqueueing;
- repeated worker-loop errors;
- sustained high attempts per completion.

Status queries do not necessarily run the exhaustion sweep. An expired final-attempt row may remain pending until the next worker claim cycle performs the sweep.

## Worker and connection-pool sizing

Each active worker needs database capacity for short claim and write-back queries, plus provider concurrency. More workers do not help after the external provider, connection pool, CPU, or storage becomes the bottleneck.

Keep provider calls outside database transactions so slow network work does not consume transaction slots, retain snapshots, delay vacuum, or hold row locks. A worker may release its database connection while awaiting the provider if the client architecture permits it.

Choose between single-item claims and batches based on failure isolation, provider behavior, and throughput. When batching, choose batch size using:

- provider maximum batch size;
- p95/p99 provider latency;
- lease duration;
- result write-back cost;
- memory use;
- acceptable duplicate-work blast radius after a crash.

## Fairness

For multiple independent queues or schemas, poll in shuffled round-robin order. Immediately draining one hot queue to completion can starve others. Process one claim—an item or bounded batch—per target per cycle, then reshuffle after productive cycles.

If a target disappears between discovery and claim, treat the database's missing-schema/table error as a lifecycle event rather than poisoning every worker cycle.

## Privileges

Separate roles where useful:

- producers can mutate source data and enqueue, but cannot claim;
- workers can claim and finalize only approved job types/tables;
- operators can inspect and explicitly retry failures;
- pruning can run under a maintenance role.

Trigger functions should normally be `SECURITY INVOKER`. If `SECURITY DEFINER` is unavoidable, lock down `search_path`, ownership, and execute privileges carefully.

## Table maintenance

Queue rows are update-heavy. Monitor dead tuples and autovacuum. Keep rows narrow, avoid unnecessary indexes, and retain terminal rows for a bounded interval. A lower table `fillfactor` can improve HOT-update opportunity when frequently updated columns are not indexed, but `visible_at` is indexed for pending rows, so claims necessarily update an index entry.

Large delete/prune batches create bloat and replication/WAL bursts. Prune incrementally when volume requires it. Partitioning is not a default queue solution; add it only after measured retention or scale problems justify the operational complexity.
