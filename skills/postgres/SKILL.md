---
name: postgres
description: |
  Use this skill for any PostgreSQL database work — table design, indexing, data types, constraints, extensions (pgvector, PostGIS, TimescaleDB), search, and migrations.

  **Trigger when user asks to:**
  - Design or modify PostgreSQL tables, schemas, or data models
  - Choose data types, constraints, indexes, or partitioning strategies
  - Work with pgvector embeddings, semantic search, or RAG
  - Set up full-text search, hybrid search, or BM25 ranking
  - Use PostGIS for spatial/geographic data
  - Set up TimescaleDB hypertables for time-series data
  - Migrate tables to hypertables or evaluate migration candidates

  **Keywords:** PostgreSQL, Postgres, SQL, schema, table design, indexes, constraints, pgvector, PostGIS, TimescaleDB, hypertable, semantic search, hybrid search, BM25, time-series
license: Apache-2.0
metadata:
  author: tigerdata
---

# PostgreSQL Expert Skills

This skill provides comprehensive PostgreSQL expertise through specialized references. Load the appropriate reference based on the task.

## Available References

### Table Design
- **[design-postgres-tables](references/design-postgres-tables.md)** — Data types, constraints, indexes, JSONB patterns, partitioning, and PostgreSQL best practices. **Use for any general table/schema design task.**
- **[design-postgis-tables](references/design-postgis-tables.md)** — PostGIS spatial table design: geometry vs geography types, SRIDs, spatial indexing, and location-based query patterns. **Use when the task involves geographic or spatial data.**

### Search
- **[pgvector-semantic-search](references/pgvector-semantic-search.md)** — Vector similarity search with pgvector: HNSW/IVFFlat indexes, halfvec storage, quantization, filtered search, and tuning. **Use for embeddings, RAG, or semantic search.**
- **[postgres-hybrid-text-search](references/postgres-hybrid-text-search.md)** — Hybrid search combining BM25 keyword search with pgvector semantic search using RRF. **Use when combining keyword and meaning-based search.**

### TimescaleDB
- **[setup-timescaledb-hypertables](references/setup-timescaledb-hypertables.md)** — Hypertable creation, compression, retention policies, continuous aggregates, and indexes. **Use when setting up TimescaleDB from scratch.**
- **[find-hypertable-candidates](references/find-hypertable-candidates.md)** — SQL queries to analyze existing tables and score them for hypertable conversion. **Use when evaluating which tables to migrate.**
- **[migrate-postgres-tables-to-hypertables](references/migrate-postgres-tables-to-hypertables.md)** — Step-by-step migration: partition column selection, in-place vs blue-green, validation. **Use when executing a migration.**

## How to Use

1. Identify which reference matches the user's task from the descriptions above.
2. Load the reference file to get detailed instructions and SQL patterns.
3. For tasks spanning multiple areas (e.g., "design a table with vector search"), load multiple references as needed.
