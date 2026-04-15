# API

All methods are exposed as MCP tools.

## Documentation Search

### `search_docs`

Unified search tool for querying documentation using semantic (vector similarity), keyword (BM25), or hybrid search (both combined with reciprocal rank fusion).

**MCP Tool**: `search_docs`

#### Input

```jsonc
{
  "source": "postgres_17", // required: tiger, postgres_14 … postgres_18 or postgres_latest, postgis_3.3 … postgis_3.6
  "search_type": "semantic", // required: "semantic", "keyword", or "hybrid"
  "query": "How do I create an index?", // required: search query
  "limit": 10 // optional: maximum results (default 10; must be positive if set)
}
```

#### Output (Semantic Search)

```jsonc
{
  "results": [
    {
      "id": 11716,
      "content": "CREATE INDEX ...",
      "metadata": "{...}", // JSON-encoded metadata
      "distance": 0.407 // lower = more relevant
    }
  ]
}
```

#### Output (Keyword Search)

```jsonc
{
  "results": [
    {
      "id": 11716,
      "content": "CREATE INDEX ...",
      "metadata": "{...}", // JSON-encoded metadata
      "score": 12.5 // higher = more relevant
    }
  ]
}
```

#### Output (Hybrid Search)

Hybrid results combine semantic and keyword rankings; each row includes `rrf_score` instead of `distance` or `score`.

```jsonc
{
  "results": [
    {
      "id": 11716,
      "content": "CREATE INDEX ...",
      "metadata": "{...}", // JSON-encoded metadata
      "rrf_score": 0.0328 // higher = more relevant (RRF fusion)
    }
  ]
}
```

## Skills

### `view_skill`

Retrieves curated skills for common PostgreSQL and TimescaleDB tasks. This tool is disabled
when deploying as a claude plugin (which use [agent skills ](https://www.claude.com/blog/skills) directly).

**MCP Tool**: `view_skill`

### Input

```jsonc
{
  "name": "setup-timescaledb-hypertables", // see available skills in tool description
  "path": "SKILL.md", // optional, defaults to "SKILL.md"
}
```

### Output

```jsonc
{
  "name": "setup-timescaledb-hypertables",
  "path": "SKILL.md",
  "description": "Step-by-step instructions for designing table schemas and setting up TimescaleDB with hypertables, indexes, compression, retention policies, and continuous aggregates.",
  "content": "...", // full skill content
}
```

**Available Skills**: Check the MCP tool description for the current list of available skills or look in the `skills` directory.
