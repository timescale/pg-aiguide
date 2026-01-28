---
name: pgvector-semantic-search
description: pgvector setup and best practices for semantic search with text embeddings in PostgreSQL
---

# pgvector for Semantic Search

Semantic search finds content by meaning rather than exact keywords. An embedding model converts text into high-dimensional vectors, where similar meanings map to nearby points. pgvector stores these vectors in PostgreSQL and uses approximate nearest neighbor (ANN) indexes to find the closest matches quickly—scaling to millions of rows without leaving the database. Store your text alongside its embedding, then query by converting your search text to a vector and returning the rows with the smallest distance.

This guide covers pgvector setup and tuning—not embedding model selection or text chunking, which significantly affect search quality. Requires pgvector 0.8.0+ for all features (`halfvec`, `binary_quantize`, iterative scan).

## Golden Path (Default Setup)

Use this configuration unless you have a specific reason not to.
- Embedding column data type: `halfvec(N)` where `N` is your embedding dimension (must match everywhere). Examples use 1536; replace with your dimension `N`.
- Distance: cosine (`<=>`)
- Index: HNSW (`m = 16`, `ef_construction = 64`). Use `halfvec_cosine_ops` and query with `<=>`.
- Query-time recall: `SET hnsw.ef_search = 100` (good starting point from published benchmarks, increase for higher recall at higher latency)
- Query pattern: `ORDER BY embedding <=> $1::halfvec(N) LIMIT k`

This setup provides a strong speed–recall tradeoff for most text-embedding workloads.

## Core Rules

- **Enable the extension** in each database: `CREATE EXTENSION IF NOT EXISTS vector;`
- **Use HNSW indexes by default**—superior speed-recall tradeoff, can be created on empty tables, no training step required. Only consider IVFFlat for write-heavy or memory-bound workloads.
- **Use `halfvec` by default**—store and index as `halfvec` for 50% smaller storage and indexes with minimal recall loss.
- **Index after bulk loading** initial data for best build performance.
- **Create indexes concurrently** in production: `CREATE INDEX CONCURRENTLY ...`
- **Use cosine distance by default** (`<=>`): For non-normalized embeddings, use cosine. For unit-normalized embeddings, cosine and inner product yield identical rankings; default to cosine.
- **Match query operator to index ops**: Index with `halfvec_cosine_ops` requires `<=>` in queries; `halfvec_l2_ops` requires `<->`; mismatched operators won't use the index.
- **Always cast query vectors explicitly** (`$1::halfvec(N)`) to avoid implicit-cast failures in prepared statements.
- **Always use the same embedding model for data and queries**. Similarity search only works when the model generating the vectors is the same.

## Type Rules

- Store embeddings as `halfvec(N)`
- Cast query vectors to `halfvec(N)`
- Store binary quantized vectors as `bit(N)` in a generated column
- Do not mix `vector` / `halfvec` / `bit` without explicit casts
- Never call `binary_quantize()` on table columns inside `ORDER BY`; store it instead
- Dimensions must match: a `halfvec(1536)` column requires query vectors cast as `::halfvec(1536)`.

## Standard Pattern

```sql
-- Store and index as halfvec
CREATE TABLE items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contents TEXT NOT NULL,
  embedding halfvec(1536) NOT NULL  -- NOT NULL requires embeddings generated before insert, not async
);
CREATE INDEX ON items USING hnsw (embedding halfvec_cosine_ops);

-- Query: returns 10 closest items. $1 is the embedding of your search text.
SELECT id, contents FROM items ORDER BY embedding <=> $1::halfvec(1536) LIMIT 10;
```

For other distance operators (L2, inner product, etc.), see the [pgvector README](https://github.com/pgvector/pgvector).

## HNSW Index

The recommended index type. Creates a multilayer navigable graph with superior speed-recall tradeoff. Can be created on empty tables (no training step required).

```sql
CREATE INDEX ON items USING hnsw (embedding halfvec_cosine_ops);

-- With tuning parameters
CREATE INDEX ON items USING hnsw (embedding halfvec_cosine_ops) WITH (m = 16, ef_construction = 64);
```

### HNSW Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `m` | 16 | Max connections per layer. Higher = better recall, more memory |
| `ef_construction` | 64 | Build-time candidate list. Higher = better graph quality, slower build |
| `hnsw.ef_search` | 40 | Query-time candidate list. Higher = better recall, slower queries. Should be ≥ LIMIT. |

**ef_search tuning (rough guidelines—actual results vary by dataset):**

| ef_search | Approx Recall | Relative Speed |
|-----------|---------------|----------------|
| 40 | lower (~95% on some benchmarks) | 1x (baseline) |
| 100 | higher  | ~2x slower |
| 200 | very-high | ~4x slower |
| 400 | near-exact | ~8x slower |

```sql
-- Set search parameter for session
SET hnsw.ef_search = 100;

-- Set for single query
BEGIN;
SET LOCAL hnsw.ef_search = 100;
SELECT id, contents FROM items ORDER BY embedding <=> $1::halfvec(1536) LIMIT 10;
COMMIT;
```

## IVFFlat Index (Generally Not Recommended)

Default to HNSW. Use IVFFlat only when HNSW’s operational costs matter more than peak recall.

Choose IVFFlat if:
- Write-heavy or constantly changing data AND you're willing to rebuild the index frequently
- You rebuild indexes often and want predictable build time and memory usage
- Memory is tight and you cannot keep an HNSW graph mostly resident
- Data is partitioned or tiered, and this index lives on colder partitions

Avoid IVFFlat if you need:
- highest recall at low latency
- minimal tuning
- a “set and forget” index

Notes:
- IVFFlat requires data to exist before index creation.
- Recall depends on `lists` and `ivfflat.probes`; higher probes = better recall, slower queries.

Starter config:
```sql
CREATE INDEX ON items
USING ivfflat (embedding halfvec_cosine_ops)
WITH (lists = 1000);

SET ivfflat.probes = 10;
```

## Quantization Strategies

- Quantization is a memory decision, not a recall decision.
- Use `halfvec` by default for storage and indexing.
- Estimate HNSW index footprint as ~4–6 KB per 1536-dim `halfvec` (m=16) (order-of-magnitude); 3072-dim is ~2×; m=32 roughly doubles HNSW link/graph overhead.
- If p95/p99 latency rises while CPU is mostly idle, the HNSW index is likely no longer resident in memory.
- If `halfvec` doesn’t fit, use binary quantization + re-ranking.

### Guidelines for 1536-dim vectors

Approximate `halfvec` capacity at `m=16`, 1536-dim (assumes RAM mostly available for index caching):

| RAM | Approx max halfvec vectors |
|-----|----------------------------|
| 16 GB | ~2–3M vectors |
| 32 GB | ~4–6M vectors |
| 64 GB | ~8–12M vectors |
| 128 GB | ~16–25M vectors |

For 3072-dim embeddings, divide these numbers by ~2.  
For `m=32`, also divide capacity by ~2.

If the index cannot fit in memory at this scale, use binary quantization.

These are ranges, not guarantees. Validate by monitoring cache residency and p95/p99 latency under load.

### Binary Quantization (For Very Large Datasets)

32× memory reduction. Use with re-ranking for acceptable recall.

```sql
-- Table with generated column for binary quantization
CREATE TABLE items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contents TEXT NOT NULL,
  embedding halfvec(1536) NOT NULL,
  embedding_bq bit(1536) GENERATED ALWAYS AS (binary_quantize(embedding)::bit(1536)) STORED
);

CREATE INDEX ON items USING hnsw (embedding_bq bit_hamming_ops);

-- Query with re-ranking for better recall
-- ef_search must be >= inner LIMIT to retrieve enough candidates
SET hnsw.ef_search = 800;
WITH q AS (
  SELECT binary_quantize($1::halfvec(1536))::bit(1536) AS qb
)
SELECT *
FROM (
  SELECT i.id, i.contents, i.embedding
  FROM items i, q
  ORDER BY i.embedding_bq <~> q.qb -- computes binary distance using index
  LIMIT 800
) candidates
ORDER BY candidates.embedding <=> $1::halfvec(1536) -- computes halfvec distance (no index), more accurate than binary
LIMIT 10;
```

The 80× oversampling ratio (800 candidates for 10 results) is a reasonable starting point. Binary quantization loses precision, so more candidates are needed to find true nearest neighbors during re-ranking. Increase if recall is insufficient; decrease if re-ranking latency is too high.

## Performance by Dataset Size

| Scale | Vectors | Config | Notes |
|-------|---------|--------|-------|
| Small | <100K | Defaults | Index optional but improves tail latency |
| Medium | 100K–5M | Defaults | Monitor p95 latency; most common production range |
| Large | 5M+ | `ef_construction=100+` | Memory residency critical |
| Very Large | 10M+ | Binary quantization + re-ranking | Add RAM or partition first if possible |

Tune `ef_search` first for recall; only increase `m` if recall plateaus and memory allows. Under concurrency, tail latency spikes when the index doesn't fit in memory. Binary quantization is an escape hatch—prefer adding RAM or partitioning first.

## Filtering Best Practices

Filtered vector search requires care. Depending on filter selectivity and query shape, filters can cause early termination (too few rows, missing results) or increase work (latency).

### Iterative scan (recommended when filters are selective)

By default, HNSW may stop early when a WHERE clause is present, which can lead to fewer results than expected. Iterative scan allows HNSW to continue searching until enough filtered rows are found.

Enable iterative scan when filters materially reduce the result set.

```sql
-- Enable iterative scans for filtered queries
SET hnsw.iterative_scan = relaxed_order;

SELECT id, contents
FROM items
WHERE category_id = 123
ORDER BY embedding <=> $1::halfvec(1536)
LIMIT 10;
```

If results are still sparse, increase the scan budget:

```sql
SET hnsw.max_scan_tuples = 50000;
```

Trade-off: increasing `hnsw.max_scan_tuples` improves recall but can significantly increase latency.

**When iterative scan is not needed:**
- The filter matches a large portion of the table (low selectivity)
- You are prefiltering via a B-tree index
- You are querying a single partition or partial index

### Choose the right filtering strategy

**Highly selective filters (under ~10k rows)**
Use a B-tree index on the filter column so Postgres can prefilter before ANN.

```sql
CREATE INDEX ON items (category_id);
```

**Low-cardinality filters (few distinct values)**
Use partial HNSW indexes per filter value.

```sql
CREATE INDEX ON items
USING hnsw (embedding halfvec_cosine_ops)
WHERE category_id = 11;
```

**Many filter values or large datasets**
Partition by the filter key to keep each ANN index small.

```sql
CREATE TABLE items (
  embedding halfvec(1536),
  category_id int
) PARTITION BY LIST (category_id);
```

### Key rules

- Filters that match few rows require prefiltering, partitioning, or iterative scan.
- Always validate filtered queries by measuring p95/p99 latency and tuples visited under realistic load.

### Alternative: pgvectorscale for label-based filtering

For large datasets with label-based filters, [pgvectorscale](https://github.com/timescale/pgvectorscale)'s StreamingDiskANN index supports filtered indexes on `smallint[]` columns. Labels are indexed alongside vectors, enabling efficient filtered search without the accuracy tradeoffs of HNSW post-filtering. See the pgvectorscale documentation for setup details.

## Bulk Loading

```sql
-- COPY is fastest; binary format is faster but requires proper encoding
-- Text format: '[0.1, 0.2, ...]'
COPY items (contents, embedding) FROM STDIN;
-- Binary format (if your client supports it):
COPY items (contents, embedding) FROM STDIN WITH (FORMAT BINARY);

-- Add indexes AFTER loading
SET maintenance_work_mem = '4GB';
SET max_parallel_maintenance_workers = 7;
CREATE INDEX ON items USING hnsw (embedding halfvec_cosine_ops);
```

## Maintenance

- **VACUUM regularly** after updates/deletes—stale entries may persist until vacuumed
- **REINDEX** if performance degrades after high churn (rebuilds the graph from scratch)
- For write-heavy workloads with frequent deletes, consider IVFFlat or partitioning by time using hypertables

## Monitoring & Debugging

```sql
-- Check index size
SELECT pg_size_pretty(pg_relation_size('items_embedding_idx'));

-- Debug query performance
EXPLAIN (ANALYZE, BUFFERS) SELECT id, contents FROM items ORDER BY embedding <=> $1::halfvec(1536) LIMIT 10;

-- Monitor index build progress
SELECT phase, round(100.0 * blocks_done / nullif(blocks_total, 0), 1) AS "%" 
FROM pg_stat_progress_create_index;

-- Compare approximate vs exact recall
BEGIN;
SET LOCAL enable_indexscan = off;  -- Force exact search
SELECT id, contents FROM items ORDER BY embedding <=> $1::halfvec(1536) LIMIT 10;
COMMIT;

-- Force index use for debugging
BEGIN;
SET LOCAL enable_seqscan = off;
SELECT id, contents FROM items ORDER BY embedding <=> $1::halfvec(1536) LIMIT 10;
COMMIT;
```

## Common Issues (Symptom → Fix)

| Symptom | Likely Cause | Fix |
|--------|--------------|-----|
| Query does not use ANN index | Missing `ORDER BY` + `LIMIT`, operator mismatch, or implicit casts | Use `ORDER BY` with a distance operator that matches the index ops class; explicitly cast query vectors |
| Fewer results than expected (filtered query) | HNSW stops early due to filter | Enable iterative scan; increase `hnsw.max_scan_tuples`; or prefilter (B-tree), use partial indexes, or partition |
| Fewer results than expected (unfiltered query) | ANN recall too low | Increase `hnsw.ef_search` |
| High latency with low CPU usage | HNSW index not resident in memory | Use `halfvec`, reduce `m`/`ef_construction`, add RAM, partition, or use binary quantization |
| Slow index builds | Insufficient build memory or parallelism | Increase `maintenance_work_mem` and `max_parallel_maintenance_workers`; build after bulk load |
| Out-of-memory errors | Index too large for available RAM | Use `halfvec`, reduce index parameters, or switch to binary quantization with re-ranking |
| Zero or missing results | NULL or zero vectors | Avoid NULL embeddings; do not use zero vectors with cosine distance |
