---
name: postgres-hybrid-text-search
description: |
  Use this skill to implement hybrid search combining BM25 keyword search with semantic vector search using Reciprocal Rank Fusion (RRF).

  **Trigger when user asks to:**
  - Combine keyword and semantic search
  - Implement hybrid search or multi-modal retrieval
  - Use BM25/pg_textsearch with pgvector together
  - Implement RRF (Reciprocal Rank Fusion) for search
  - Build search that handles both exact terms and meaning


  **Keywords:** hybrid search, BM25, pg_textsearch, RRF, reciprocal rank fusion, keyword search, full-text search, reranking, cross-encoder

  Covers: pg_textsearch BM25 index setup, parallel query patterns, client-side RRF fusion (Python/TypeScript), weighting strategies, and optional ML reranking.
---

# Hybrid Text Search

Hybrid search combines keyword search (BM25) with semantic search (vector embeddings) to get the best of both: exact keyword matching and meaning-based retrieval. Use Reciprocal Rank Fusion (RRF) to merge results from both methods into a single ranked list.

This guide covers combining [pg_textsearch](https://github.com/timescale/pg_textsearch) (BM25) with [pgvector](https://github.com/pgvector/pgvector). Requires both extensions. For high-volume setups, filtering, or advanced pgvector tuning (binary quantization, HNSW parameters), see the **pgvector-semantic-search** skill.

pg_textsearch is a new BM25 text search extension for PostgreSQL, fully open-source and available hosted on Tiger Cloud as well as for self-managed deployments. It provides true BM25 ranking, which often improves relevance compared to PostgreSQL's built-in ts_rank and can offer better performance at scale. Note: pg_textsearch is currently in prerelease and not yet recommended for production use. pg_textsearch currently supports PostgreSQL 17 and 18.

## When to Use Hybrid Search

- **Use hybrid** when queries mix specific terms (product names, codes, proper nouns) with conceptual intent
- **Use semantic only** when meaning matters more than exact wording (e.g., "how to fix slow queries" should match "query optimization")
- **Use keyword only** when exact matches are critical (e.g., error codes, SKUs, legal citations)

Hybrid search typically improves recall over either method alone, at the cost of slightly more complexity.

## Data Preparation

Chunk your documents into smaller pieces (typically 500–1000 tokens) and store each chunk with its embedding. Both BM25 and semantic search operate on the same chunks—this keeps fusion simple since you're comparing like with like.

## Golden Path (Default Setup)

```sql
-- Enable extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_textsearch;

-- Table with both indexes
CREATE TABLE documents (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  content TEXT NOT NULL,
  embedding halfvec(1536) NOT NULL
);

-- BM25 index for keyword search
CREATE INDEX ON documents USING bm25 (content) WITH (text_config = 'english');

-- HNSW index for semantic search
CREATE INDEX ON documents USING hnsw (embedding halfvec_cosine_ops);
```

### BM25 Notes

- **Negative scores**: The `<@>` operator returns negative values where lower = better match. RRF uses rank position, so this doesn't affect fusion.
- **Language config**: Change `text_config` to match your content language (e.g., `'french'`, `'german'`). See [PostgreSQL text search configurations](https://www.postgresql.org/docs/current/textsearch-configuration.html).
- **Tuning**: BM25 has `k1` (term frequency saturation, default 1.2) and `b` (length normalization, default 0.75) parameters. Defaults work well; only tune if relevance is poor.
  ```sql
  CREATE INDEX ON documents USING bm25 (content) WITH (text_config = 'english', k1 = 1.5, b = 0.8);
  ```
- **Partitioned tables**: Each partition maintains local statistics. Scores are not directly comparable across partitions—query individual partitions when score comparability matters.

## RRF Query Pattern

Reciprocal Rank Fusion combines rankings from multiple searches. Each result's score is `1 / (k + rank)` where `k` is a constant (typically 60). Results are summed across searches and re-sorted.

**Run both queries in parallel from your client** for lower latency, then fuse results client-side:

```sql
-- Query 1: Keyword search (BM25)
-- $1: search text
SELECT id, content FROM documents ORDER BY content <@> $1 LIMIT 50;
```

```sql
-- Query 2: Semantic search (separate query, run in parallel)
-- $1: embedding of your search text as halfvec(1536)
SELECT id, content FROM documents ORDER BY embedding <=> $1::halfvec(1536) LIMIT 50;
```

```python
# Client-side RRF fusion (Python)
def rrf_fusion(keyword_results, semantic_results, k=60, limit=10):
    scores = {}
    content_map = {}

    for rank, row in enumerate(keyword_results, start=1):
        scores[row['id']] = scores.get(row['id'], 0) + 1 / (k + rank)
        content_map[row['id']] = row['content']

    for rank, row in enumerate(semantic_results, start=1):
        scores[row['id']] = scores.get(row['id'], 0) + 1 / (k + rank)
        content_map[row['id']] = row['content']

    sorted_ids = sorted(scores, key=scores.get, reverse=True)[:limit]
    return [{'id': id, 'content': content_map[id], 'score': scores[id]} for id in sorted_ids]
```

```typescript
// Client-side RRF fusion (TypeScript)
type Row = { id: number; content: string };
type Result = Row & { score: number };

function rrfFusion(keywordResults: Row[], semanticResults: Row[], k = 60, limit = 10): Result[] {
  const scores = new Map<number, number>();
  const contentMap = new Map<number, string>();

  keywordResults.forEach((row, i) => {
    scores.set(row.id, (scores.get(row.id) ?? 0) + 1 / (k + i + 1));
    contentMap.set(row.id, row.content);
  });

  semanticResults.forEach((row, i) => {
    scores.set(row.id, (scores.get(row.id) ?? 0) + 1 / (k + i + 1));
    contentMap.set(row.id, row.content);
  });

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, score]) => ({ id, content: contentMap.get(id)!, score }));
}
```

### RRF Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `k` | 60 | Smoothing constant. Higher values reduce rank differences; 60 is standard |
| Candidates per search | 50 | Higher = better recall, more work |
| Final limit | 10 | Results returned after fusion |

Increase candidates if relevant results are being missed. The k=60 constant rarely needs tuning.

## Weighting Keyword vs Semantic

To favor one method over another, multiply its RRF contribution:

```python
# Weight semantic search 2x higher than keyword
keyword_weight = 1.0
semantic_weight = 2.0

for rank, row in enumerate(keyword_results, start=1):
    scores[row['id']] = scores.get(row['id'], 0) + keyword_weight / (k + rank)

for rank, row in enumerate(semantic_results, start=1):
    scores[row['id']] = scores.get(row['id'], 0) + semantic_weight / (k + rank)
```

```typescript
// Weight semantic search 2x higher than keyword
const keywordWeight = 1.0;
const semanticWeight = 2.0;

keywordResults.forEach((row, i) => {
  scores.set(row.id, (scores.get(row.id) ?? 0) + keywordWeight / (k + i + 1));
});

semanticResults.forEach((row, i) => {
  scores.set(row.id, (scores.get(row.id) ?? 0) + semanticWeight / (k + i + 1));
});
```

Start with equal weights (1.0 each) and adjust based on measured relevance.

## Reranking with ML Models

For highest quality, add a reranking step using a cross-encoder model. Cross-encoders (e.g., `cross-encoder/ms-marco-MiniLM-L-6-v2`) are more accurate than bi-encoders but too slow for initial retrieval—use them only on the candidate set.

Run the same parallel queries as above with a higher LIMIT (e.g., 100), then:

```python
# 1. Fuse results with RRF (more candidates for reranking)
candidates = rrf_fusion(keyword_results, semantic_results, limit=100)

# 2. Rerank with cross-encoder
from sentence_transformers import CrossEncoder
reranker = CrossEncoder('cross-encoder/ms-marco-MiniLM-L-6-v2')

pairs = [(query_text, doc['content']) for doc in candidates]
scores = reranker.predict(pairs)

# 3. Return top 10 by reranker score
reranked = sorted(zip(candidates, scores), key=lambda x: x[1], reverse=True)[:10]
```

```typescript
import { CohereClientV2 } from 'cohere-ai';

// 1. Fuse results with RRF (more candidates for reranking)
const candidates = rrfFusion(keywordResults, semanticResults, 60, 100);

// 2. Rerank via API (example uses Cohere SDK; Jina, Voyage, and others work similarly)
const cohere = new CohereClientV2({ token: COHERE_API_KEY });

const reranked = await cohere.rerank({
  model: 'rerank-v3.5',
  query: queryText,
  documents: candidates.map(c => c.content),
  topN: 10
});

// 3. Map back to original documents
const results = reranked.results.map(r => candidates[r.index]);
```

Reranking is optional—hybrid RRF alone significantly improves over single-method search.

## Performance Considerations

- **Index both columns**: BM25 index on text, HNSW index on embedding
- **Limit candidate pools**: 50–100 candidates per method is usually sufficient
- **Run queries in parallel**: Client-side parallelism reduces latency vs sequential execution
- **Monitor latency**: Hybrid adds overhead; ensure both indexes fit in memory

## Scaling with pgvectorscale

For large datasets (10M+ vectors) or workloads with selective metadata filters, consider [pgvectorscale](https://github.com/timescale/pgvectorscale)'s StreamingDiskANN index instead of HNSW for the semantic search component.

**When to use StreamingDiskANN:**
- Large datasets where HNSW doesn't fit in memory
- Queries that filter by labels (e.g., tenant_id, category, tags)
- When you need high-performance filtered vector search

**Label-based filtering:** StreamingDiskANN supports filtered indexes on `smallint[]` label columns. Labels are indexed alongside vectors, enabling efficient filtered search without post-filtering accuracy loss.

```sql
-- Enable pgvectorscale (in addition to pgvector)
CREATE EXTENSION IF NOT EXISTS vectorscale;

-- Table with label column for filtering
CREATE TABLE documents (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  content TEXT NOT NULL,
  embedding halfvec(1536) NOT NULL,
  labels smallint[] NOT NULL  -- e.g., category IDs, tenant IDs
);

-- StreamingDiskANN index with label filtering
CREATE INDEX ON documents USING diskann (embedding vector_cosine_ops, labels);

-- BM25 index for keyword search
CREATE INDEX ON documents USING bm25 (content) WITH (text_config = 'english');

-- Filtered semantic search using && (array overlap)
SELECT id, content FROM documents
WHERE labels && ARRAY[1, 3]::smallint[]
ORDER BY embedding <=> $1::halfvec(1536) LIMIT 50;
```

See the [pgvectorscale documentation](https://github.com/timescale/pgvectorscale) for more details on filtered indexes and tuning parameters.

## Monitoring & Debugging

```sql
-- Force index usage for verification (planner may prefer seqscan on small tables)
SET enable_seqscan = off;

-- Verify BM25 index is used
EXPLAIN SELECT id, content FROM documents ORDER BY content <@> 'search text' LIMIT 10;
-- Look for: Index Scan using ... (bm25)

-- Verify HNSW index is used
EXPLAIN SELECT id, content FROM documents ORDER BY embedding <=> '[0.1, 0.2, ...]'::halfvec(1536) LIMIT 10;
-- Look for: Index Scan using ... (hnsw)

SET enable_seqscan = on;  -- Re-enable for normal operation

-- Check index sizes
SELECT indexname, pg_size_pretty(pg_relation_size(indexname::regclass)) AS size
FROM pg_indexes WHERE tablename = 'documents';
```

If EXPLAIN still shows sequential scans with `enable_seqscan = off`, verify indexes exist and queries use correct operators (`<@>` for BM25, `<=>` for cosine). For more pgvector debugging guidance, see the **pgvector-semantic-search** skill.

## Common Issues

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| Missing exact matches | Keyword search not returning them | Check BM25 index exists; verify text_config matches content language |
| Poor semantic results | Embedding model mismatch | Ensure query embedding uses same model as stored embeddings |
| Slow queries | Large candidate pools or missing indexes | Reduce inner LIMIT; verify both indexes exist and are used (EXPLAIN) |
| Skewed results | One method dominating | Adjust RRF weights; verify both searches return reasonable candidates |
