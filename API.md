# API

All methods are exposed as MCP tools.

## Documentation Search

### `search_docs`

Unified search tool for documentation using **semantic** (vector similarity), **keyword** (BM25), or **hybrid** (both, merged with reciprocal rank fusion).

**MCP Tool**: `search_docs`

#### Input

```jsonc
{
  // required — corpus and optional version encoded in one enum value:
  "source": "postgres_17",
  //   "tiger" | "postgres_14" … "postgres_18" | "postgis_3.3" … "postgis_3.6"
  "search_type": "semantic", // required: "semantic" | "keyword" | "hybrid"
  "query": "How do I create an index?", // required
  "limit": 10 // optional; default 10 if omitted
}
```

- **`source`**: `tiger` (Tiger Cloud / TimescaleDB), `postgres_XX` for a specific PostgreSQL manual version, or `postgis_X.X` for PostGIS. There is no separate `version` field.
- **`search_type`**: `hybrid` runs semantic and keyword search in parallel (two DB queries), fuses ranked lists with RRF (`k = 60`), and returns `rrf_score` per row (no `distance` or `score` on hybrid results).

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

```jsonc
{
  "results": [
    {
      "id": 11716,
      "content": "CREATE INDEX ...",
      "metadata": "{...}", // JSON-encoded metadata
      "rrf_score": 0.0328 // higher = more relevant; RRF of semantic + keyword ranks
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
