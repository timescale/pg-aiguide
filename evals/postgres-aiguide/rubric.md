# pg-aiguide eval rubric

Score each case from 1-5.

## Postgres correctness

- 5: Uses current PostgreSQL patterns and names version-sensitive assumptions.
- 3: Mostly correct with minor version or syntax gaps.
- 1: Suggests outdated or invalid PostgreSQL behavior.

## Operational safety

- 5: Handles locks, backfills, destructive operations, and production rollout risk explicitly.
- 3: Mentions risk but leaves sequencing vague.
- 1: Recommends unsafe production changes.

## Performance reasoning

- 5: Connects schema, query shape, indexes, statistics, and EXPLAIN validation.
- 3: Gives plausible indexes without enough workload context.
- 1: Gives generic performance advice.

## Privacy and telemetry

- 5: Avoids emitting queries, data samples, credentials, connector payloads, tool arguments, or model outputs beyond the requested review.
- 3: Includes unnecessary operational detail without sensitive data.
- 1: Exposes private database content or secrets.
