# Testing PostgreSQL Work Queues

Queue tests must exercise transaction boundaries and races against a real PostgreSQL server. Mocked SQL and single-connection tests cannot validate row locks, `SKIP LOCKED`, lease expiry, or concurrent finalization.

## Test harness principles

- Use independent database connections for concurrent workers.
- Keep each test in an isolated schema or database.
- Use controllable worker/provider fakes that can pause between claim and completion.
- Prefer explicit barriers/promises over arbitrary sleeps.
- Use very short or zero lease intervals only in tests designed for immediate expiry.
- Query queue rows directly to assert state transitions.
- Assert both the queue outcome and the source/result state.
- Run tests repeatedly or under randomized scheduling to expose flakes.

## Schema and enqueue tests

1. **Insert without a result enqueues once.** Assert source ID and source version.
2. **Insert with a precomputed result does not enqueue.**
3. **Relevant source change advances the version and enqueues new work.**
4. **Irrelevant metadata change does not enqueue.**
5. **No-op update does not enqueue.** Use `IS DISTINCT FROM` semantics.
6. **Source mutation and enqueue roll back together.** Force a transaction error.
7. **Direct SQL writers trigger enqueueing.** Do not test only through the application API.
8. **Deleting many source rows uses the FK index.** Include an `EXPLAIN` or performance regression where appropriate.

## Claim tests

1. **Empty queue returns no work.**
2. **Claim supports `LIMIT 1` and respects bounded batch size and deterministic order.**
3. **Claim increments attempts and claim version.**
4. **Claim moves `visible_at` into the future.**
5. **Concurrent workers claim disjoint rows.** Start two claims together on separate connections and assert every initial generation is claimed once.
6. **A locked first row does not block later rows.** Hold one candidate lock and verify another worker skips it.
7. **Expired leases are reclaimable.** Assert a new claim version.
8. **Unexpired leases are not reclaimable.**
9. **Stale source versions are cancelled, not claimed.**
10. **A stale-only claim does not make the continuous worker sleep while more work exists.**

Do not describe the concurrent-claim test as proving jobs can never execute twice. It proves one active claim generation at a time; lease expiry intentionally permits another generation.

## Completion and fencing tests

1. **Current generation completes and installs its result.**
2. **Duplicate completion is a no-op.**
3. **Expired generation cannot finalize after reclaim.** Pause worker A, expire/reclaim with worker B, then resume A.
4. **Source change during external work cancels old completion.** Assert the old result was not installed and new work remains.
5. **Source deletion during work cannot install a result.**
6. **Direct precomputed result supersedes pending work.** Assert the worker cannot overwrite it.
7. **A terminal/cancelled row cannot write a result later.**
8. **Partial batch results are associated with the correct job IDs.**
9. **One row's write-back failure does not corrupt another row's outcome.**

## Retry and failure tests

1. **Ordinary failure records a bounded diagnostic and remains pending.**
2. **A failed row is invisible until its retry/lease delay expires.**
3. **Each ordinary claim consumes one attempt.**
4. **Rate limit refunds the attempt and defers visibility.**
5. **Another worker cannot immediately reclaim a rate-limited row.**
6. **Provider-wide gate pauses sibling workers in the same pool.**
7. **Configuration fault does not burn through the queue in a tight loop.**
8. **Final attempt remains pending while its lease is unexpired.**
9. **A later sweep terminally fails an expired exhausted row.**
10. **Crash after final claim is eventually swept to failed.**
11. **Concurrent explicit retries reset a terminal row at most once.**
12. **Retry skips stale, resolved, already-retried, unknown, and pruned IDs.**
13. **Retry advances the claim generation and resets diagnostics/attempts.**

## Crash-window tests

Inject termination or simulate loss at each boundary:

| Boundary | Expected recovery |
| --- | --- |
| Before claim commit | No durable claim; another worker may claim immediately. |
| After claim commit, before external call | Lease expires; work is retried. |
| During external call | Lease expires; duplicate remote execution is possible. |
| After remote success, before DB completion | Retry occurs; downstream idempotency must deduplicate. |
| During DB completion transaction | Transaction is atomic: result and queue finalization both commit or neither does. |
| After DB completion commit | Redelivery sees terminal outcome and cannot repeat DB write-back. |

For remote effects, use a fake receiver with an idempotency-key uniqueness constraint and assert that multiple deliveries produce one accepted effect.

## Worker-loop tests

- Worker drains immediately while work exists.
- Worker sleeps after an idle claim.
- Stop interrupts idle sleep promptly.
- Stop prevents another claim but allows the in-flight item or batch to finish.
- A throwing error callback does not stop the worker.
- Consecutive worker errors produce bounded exponential backoff.
- Successful processing resets the error counter.
- Idle prune failure is reported but does not poison claim processing.
- Forced termination makes no rollback claim and relies on lease recovery.

## Observability and retention tests

- Pending, waiting, hidden, failed, and oldest-pending metrics match seeded states.
- Hidden includes retry-delayed rows, not only actively executing calls.
- Status inspection does not unexpectedly mutate queue state.
- Failure listing uses stable keyset pagination.
- Stale historical failures are excluded from the current-failure view.
- Pruning removes only terminal rows older than retention.
- Pending rows are never pruned by terminal retention.
- Error diagnostics are length-bounded and redacted at unrestricted surfaces.

## Query-plan tests

On representative data, verify:

- claim uses the partial `(visible_at, id)` index;
- source/version stale checks use the pending source index;
- terminal prune uses the archive index;
- source deletion uses the unfiltered FK index;
- parameterized prepared statements retain acceptable plans.

Do not force index usage in production merely to satisfy a tiny test fixture. Seed enough rows or temporarily disable sequential scans only in a diagnostic transaction, and inspect realistic `EXPLAIN (ANALYZE, BUFFERS)` output.

## Load and soak tests

Measure under realistic producer and worker concurrency:

- enqueue throughput and producer commit latency;
- claim throughput and lock waits;
- queue age under sustained arrival rate;
- duplicate remote-call rate with intentionally short leases;
- recovery after killing workers;
- WAL volume, dead tuples, autovacuum, and table/index growth;
- prune impact;
- provider throttling behavior.

A load test should include source churn so stale cancellation and re-enqueueing are exercised, not only immutable happy-path jobs.
