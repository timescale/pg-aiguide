---
name: implement-postgres-work-queues
description: |
  Use this skill whenever implementing, reviewing, or debugging a durable PostgreSQL-backed work queue.

  **Trigger when user asks to:**
  - Build a job queue, task queue, application worker, or asynchronous processing system backed by PostgreSQL
  - Use `FOR UPDATE SKIP LOCKED`, leases, visibility timeouts, retries, or dead-letter handling
  - Enqueue work transactionally with source-data changes
  - Process embeddings, webhooks, email, imports, media, or other deferred work from PostgreSQL
  - Make multiple workers claim jobs concurrently without losing work
  - Diagnose duplicate execution, stuck jobs, stale write-back, retry storms, or queue-table growth

  **Keywords:** PostgreSQL queue, work queue, job queue, application worker, queue consumer, SKIP LOCKED, lease, visibility timeout, retry, worker, transactional enqueue, outbox, at-least-once, idempotency, dead letter

  Covers: transactional enqueueing, set-based concurrent claims, short transactions, lease-based crash recovery, stale-result fencing, retries and rate limits, terminal failure inspection, worker operation, observability, pruning, and concurrency testing.
license: Apache-2.0
compatibility: PostgreSQL 16+
metadata:
  author: tigerdata
---

# PostgreSQL Work Queues

A reliable PostgreSQL work queue is a small state machine, not merely a query containing `FOR UPDATE SKIP LOCKED`. The design must account for worker crashes, expired leases, duplicate execution, changing source data, retry exhaustion, and operational cleanup.

This skill covers application workers and queue consumers that connect to PostgreSQL as clients. It does not cover PostgreSQL extension background workers (`BackgroundWorker` processes running inside the database server).

Use PostgreSQL as the queue when work is closely coupled to database state, transactional enqueueing is valuable, and polling latency and throughput fit the database. Prefer a dedicated broker when the workload needs very high fan-out, sub-poll-interval delivery latency, broker-specific routing, or isolation from the primary database's load.

## Delivery Guarantee

Design for **at-least-once execution**:

- A worker can finish external work and crash before recording completion.
- A lease can expire while a slow worker is still running, allowing another worker to claim the same job.
- Provider SDK retries can issue multiple remote requests during one queue attempt.

PostgreSQL can make claiming and database write-back atomic, but it cannot make an arbitrary remote side effect and a database commit one atomic operation. Make processing idempotent, pass a stable idempotency key to downstream systems, or use a downstream deduplication mechanism. Do not claim exactly-once external execution.

## Golden Path

```text
change source data and enqueue in one transaction
→ claim one item or a bounded batch in a short transaction
→ commit the claim
→ perform external work outside every database transaction
→ finalize in another short, fenced transaction
```

The external-work boundary is essential. Never hold row locks or an open transaction while calling an embedding provider, webhook, email service, model, object store, or other remote system.

## Core Invariants

1. **Enqueue atomically.** Insert the job in the same transaction as the source mutation. Use a database trigger when all writers, including direct SQL writers, must enqueue correctly.
2. **Claim atomically.** Lock one item or a bounded candidate set with `FOR UPDATE SKIP LOCKED`, then update and return the selected work in the same statement. Use `LIMIT 1` when each claim should return one item.
3. **Commit before working.** A claim transaction only validates, leases, and returns jobs.
4. **Use a lease.** Move `visible_at` into the future. If a worker disappears, the job becomes claimable after the lease expires.
5. **Increment attempts at claim time.** A crash after claim is still an attempt. Do not terminally fail the final attempt until its lease has expired.
6. **Fence completion.** Match the current claim generation when finalizing. If work derives from mutable data, also match the source version used to produce the result.
7. **Keep retries durable.** The queue, not an in-memory worker or provider SDK, owns retry state.
8. **Treat stale work as cancellation.** A job for an old source version is obsolete, not operationally failed.
9. **Retain terminal rows temporarily.** Operators need to inspect failures; pruning prevents unbounded growth.
10. **Poll deliberately.** Do not add `LISTEN`/`NOTIFY` as a queue wake-up path. Notifications introduce shared commit-path coordination and are a poor fit for a high-write work queue. Adaptive polling keeps queue correctness and commit throughput independent of notification delivery.

## State Model

A compact queue can use a nullable terminal `outcome` plus `visible_at`:

| State | Predicate | Meaning |
| --- | --- | --- |
| Waiting | `outcome IS NULL AND visible_at <= now()` | Eligible for a claim, unless attempts are exhausted. |
| Hidden | `outcome IS NULL AND visible_at > now()` | Claimed under a lease or deliberately delayed for retry/backoff. |
| Completed | `outcome = 'completed'` | Result or side effect was accepted. |
| Failed | `outcome = 'failed'` | Attempt budget was exhausted or the job was terminally rejected. |
| Cancelled | `outcome = 'cancelled'` | Source disappeared, changed, or otherwise superseded the job. |

`visible_at` answers one queue question: **when may another worker claim this row?** A future value does not prove that a worker is currently executing it; it can also represent retry or rate-limit delay. Reflect that limitation in metric names and documentation.

Use a monotonically increasing `claim_version` (also called a claim generation) to prevent a worker from finalizing a lease that has expired and been reclaimed. Use a separate source version to prevent a correctly claimed job from installing a result derived from obsolete data.

## Implementation Workflow

### 1. Define semantics first

Decide:

- What source mutation creates work?
- Is there one job per source version, or may duplicates coexist?
- What is the stable downstream idempotency key?
- Which failures are retryable, terminal, stale, or rate limits?
- How long can the complete operation take, including SDK retries?
- How are operators expected to inspect and retry failures?

### 2. Create the table and indexes

Read [queue-schema-and-enqueueing.md](references/queue-schema-and-enqueueing.md) for the schema, constraints, partial indexes, transactional enqueue patterns, triggers, deduplication, and foreign-key indexing.

### 3. Implement claim and lease expiry

Read [claiming-and-leases.md](references/claiming-and-leases.md) for the set-based claim query, transaction boundary, attempt sweep, concurrency behavior, lease sizing, and crash windows.

### 4. Fence write-back

Read [completion-and-fencing.md](references/completion-and-fencing.md) for claim-generation fencing, source-version fencing, stale cancellation, remote idempotency, and atomic result installation.

### 5. Define retry behavior

Read [retries-and-failures.md](references/retries-and-failures.md) for ordinary failures, rate limits, attempt accounting, exhaustion, explicit terminal retries, diagnostics, and pruning.

### 6. Operate the worker

Read [worker-operation-and-observability.md](references/worker-operation-and-observability.md) for adaptive polling, graceful shutdown, backoff, metrics, queue-age alerts, privileges, and maintenance.

### 7. Test the failure windows

Read [testing-work-queues.md](references/testing-work-queues.md). Queue correctness requires database integration tests with independent connections and controlled races; happy-path unit tests are insufficient.

For a cohesive implementation, read [work-queue-complete-example.md](references/work-queue-complete-example.md) after the conceptual references. Adapt its assumptions rather than copying it blindly.

## Essential Claim Shape

```sql
WITH candidate AS (
  SELECT q.id
  FROM work_queue AS q
  WHERE q.outcome IS NULL
    AND q.visible_at <= pg_catalog.now()
    AND q.attempts < q.max_attempts
  ORDER BY q.visible_at, q.id
  FOR UPDATE SKIP LOCKED
  LIMIT $1
)
UPDATE work_queue AS q
SET attempts = q.attempts + 1,
    claim_version = q.claim_version + 1,
    visible_at = pg_catalog.now() + $2::interval,
    updated_at = pg_catalog.now()
FROM candidate AS c
WHERE q.id = c.id
RETURNING q.*;
```

Run this in a short transaction and commit before processing. Set the limit to `1` for a single-item claim or higher for a bounded batch. Production claims commonly add source joins or stale-cancellation CTEs, but preserve this bounded lock-and-update shape.

## Completion Fences

At minimum, completion should match the active job and the claim generation:

```sql
UPDATE work_queue
SET outcome = 'completed',
    updated_at = pg_catalog.now()
WHERE id = $1
  AND outcome IS NULL
  AND claim_version = $2;
```

For derived data, also update the source only while its current version matches the job's `source_version`, and finalize the queue row atomically as either `completed` or `cancelled`. A claim fence protects against an expired worker; a source fence protects against an obsolete input. They solve different races.

## Anti-Patterns

Do not:

- call remote services while the claim transaction is open;
- delete a job when claiming it;
- use `SKIP LOCKED` without a durable lease;
- run an unbounded claim;
- allow an expired claim to complete without a generation/ownership check;
- install derived results without checking their source version;
- assume a lease prevents duplicate external execution;
- retry immediately in a tight loop;
- spend the normal job attempt budget on provider-wide rate limits without an explicit reason;
- mark a final attempt failed before its lease expires;
- store unlimited or unrestricted raw provider errors;
- retain terminal rows forever;
- forget to index a queue foreign key used by cascading deletes;
- rely on queue depth alone—monitor oldest pending age;
- use `LISTEN`/`NOTIFY` to drive queue wake-ups;
- promise exactly-once delivery.
