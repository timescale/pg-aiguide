# Queue Schema and Enqueueing

## Recommended schema

This schema supports leased, at-least-once work derived from a mutable source row:

```sql
CREATE TABLE work_queue (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id UUID NOT NULL REFERENCES source_record(id) ON DELETE CASCADE,
  source_version INTEGER NOT NULL CHECK (source_version > 0),
  job_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(payload) = 'object'),
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
  UNIQUE (source_id, source_version, job_type)
);
```

Adapt these choices rather than adding columns speculatively:

- Omit `source_id` and `source_version` for jobs that do not derive from mutable rows.
- Use the source table's actual key type.
- Keep large or sensitive input in the source table and queue a reference rather than copying it into `payload`.
- Store `max_attempts` per job when policies differ by job type. A system with one deployment-wide policy may keep it in worker configuration, but every worker performing the exhaustion sweep must agree on that policy.
- The unique constraint gives one durable job per source version and type, including terminal history. Omit or change it when duplicate jobs are intentional.

`claim_version` identifies the current claim generation. Increment it every time the row is claimed. A completion from generation 2 cannot finalize a row that has already been reclaimed as generation 3.

## Indexes are access paths

```sql
-- Find the oldest visible pending work without indexing terminal history.
CREATE INDEX work_queue_claim_idx
ON work_queue (visible_at, id)
WHERE outcome IS NULL;

-- Find pending work for a source and detect superseded versions.
CREATE INDEX work_queue_source_pending_idx
ON work_queue (source_id, source_version DESC)
WHERE outcome IS NULL;

-- Prune retained terminal rows efficiently.
CREATE INDEX work_queue_archive_idx
ON work_queue (updated_at)
WHERE outcome IS NOT NULL;

-- Support the FK check and ON DELETE CASCADE without repeatedly scanning the queue.
CREATE INDEX work_queue_source_id_idx
ON work_queue (source_id);
```

PostgreSQL does not automatically index referencing foreign-key columns. The unfiltered `source_id` index matters even if a partial pending-work index starts with `source_id`: cascading deletion must find pending and terminal children. Omitting this index can make bulk source deletion perform repeated queue-table scans.

The claim index should match the claim predicate and ordering. If the claim query orders by `(visible_at, id)`, index both columns. Do not add indexes for fields the worker never queries; every queue update must maintain them.

## Why one `visible_at` works

`visible_at` represents the earliest time another worker may claim a row:

- initial enqueue: visible now or at a scheduled time;
- successful claim: lease expiry;
- ordinary retry: next retry time;
- rate limit: provider backoff deadline;
- explicit terminal retry: reset to now.

This compact representation intentionally does not distinguish an executing job from a delayed retry. Operationally describe `visible_at > now()` as **hidden**, not definitively active. If precise worker-presence tracking is a product requirement, use separate ephemeral worker telemetry; a database lease never proves the worker is alive.

## Enqueue in the source transaction

If one application path owns all writes, enqueue explicitly in the same transaction:

```sql
BEGIN;

UPDATE source_record
SET content = $2,
    content_version = content_version + 1
WHERE id = $1
RETURNING id, content_version;

INSERT INTO work_queue (source_id, source_version, job_type)
VALUES ($1, $returned_version, 'derive');

COMMIT;
```

Never commit the source mutation and then enqueue in a second transaction. A crash between commits creates permanently missing work.

Use `INSERT ... ON CONFLICT DO NOTHING` only when the matching unique constraint deliberately makes enqueue idempotent. Do not use conflict suppression to hide an unexplained duplicate.

## Trigger enqueueing

Use a database trigger when direct SQL, imports, administration scripts, or multiple services can mutate source rows. The trigger makes the invariant belong to the database rather than one application path.

```sql
CREATE FUNCTION enqueue_source_work()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  INSERT INTO public.work_queue (source_id, source_version, job_type)
  VALUES (NEW.id, NEW.content_version, 'derive');
  RETURN NEW;
END;
$function$;

CREATE TRIGGER source_enqueue_insert
AFTER INSERT ON source_record
FOR EACH ROW
WHEN (NEW.derived_value IS NULL)
EXECUTE FUNCTION enqueue_source_work();

CREATE TRIGGER source_enqueue_update
AFTER UPDATE OF content ON source_record
FOR EACH ROW
WHEN (
  OLD.content IS DISTINCT FROM NEW.content
  AND NEW.derived_value IS NULL
)
EXECUTE FUNCTION enqueue_source_work();
```

The source table must advance `content_version` whenever an input affecting the derived result changes. This can be application-owned or enforced by a separate `BEFORE` trigger. Ensure trigger ordering and behavior are covered by integration tests.

An insert that already supplies a valid derived value should not enqueue redundant work. Likewise, setting a derived value directly may advance the source fence without enqueueing; the next claim should cancel the now-stale pending row.

## Enqueue payload versus source reference

Prefer a source reference plus version when:

- source content is large;
- access control applies to the source;
- stale work should be cancelled automatically;
- queue payload retention would duplicate sensitive data.

Use an immutable payload when the job must preserve the exact request even if the source later changes. In that model, changing the source does not necessarily make the job stale, and completion may need only claim fencing and downstream idempotency.

## Coalescing and supersession

For derived work, every source version can enqueue a row while claims cancel obsolete versions. This preserves history and keeps source writes simple. Under extreme update rates, a coalescing design can maintain one pending row per source, but it complicates races between enqueue, active claims, and completion. Start with immutable versioned jobs unless queue volume proves coalescing necessary.

## Do not add notification wake-ups

Use adaptive polling: continue immediately while claims succeed and sleep only when a claim finds no work. Do not add `LISTEN`/`NOTIFY` as an optimization. Notification publication introduces shared commit-path coordination at cluster scope, coupling queue producers to unrelated notifying transactions and undermining write scalability. The queue table and polling loop are the complete durable mechanism.
