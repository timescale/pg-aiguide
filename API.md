# API

All methods are exposed as MCP tools.

## Documentation Search

### `search_docs`

Unified search tool for querying documentation using semantic (vector similarity) or keyword (BM25) search.

**MCP Tool**: `search_docs`

#### Input

```jsonc
{
  "source": "postgres", // required: "postgres", "tiger", or "postgis"
  "search_type": "semantic", // required: "semantic" or "keyword"
  "query": "How do I create an index?", // required: search query
  "version": "17", // required: PostgreSQL version ("14"-"18" or "latest"), ignored for tiger/postgis
  "limit": 10 // required: maximum results to return
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
