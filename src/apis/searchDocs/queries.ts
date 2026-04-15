import type { Pool } from 'pg';
import type { DocsSource, KeywordResult, SemanticResult } from './schemas.js';

async function semanticSearchTiger(
  pgPool: Pool,
  schema: string,
  embeddingJson: string,
  limit: number,
): Promise<SemanticResult[]> {
  const result = await pgPool.query<SemanticResult>(
    /* sql */ `
SELECT
  id::int,
  content,
  metadata::text,
  embedding <=> $1::vector(1536) AS distance
 FROM ${schema}.timescale_chunks
 ORDER BY distance
 LIMIT $2
`,
    [embeddingJson, limit],
  );
  return result.rows;
}

async function semanticSearchPostgres(
  pgPool: Pool,
  schema: string,
  embeddingJson: string,
  version: string | null,
  limit: number,
): Promise<SemanticResult[]> {
  const result = await pgPool.query<SemanticResult>(
    /* sql */ `
SELECT
  c.id::int,
  c.content,
  c.metadata::text,
  c.embedding <=> $1::vector(1536) AS distance
 FROM ${schema}.postgres_chunks c
 JOIN ${schema}.postgres_pages p ON c.page_id = p.id
 WHERE p.version = $2
 ORDER BY distance
 LIMIT $3
`,
    [embeddingJson, version, limit],
  );
  return result.rows;
}

async function semanticSearchPostgis(
  pgPool: Pool,
  schema: string,
  embeddingJson: string,
  limit: number,
): Promise<SemanticResult[]> {
  const result = await pgPool.query<SemanticResult>(
    /* sql */ `
SELECT
  id::int,
  content,
  metadata::text,
  embedding <=> $1::vector(1536) AS distance
 FROM ${schema}.postgis_chunks
 ORDER BY distance
 LIMIT $2
`,
    [embeddingJson, limit],
  );
  return result.rows;
}

async function keywordSearchTiger(
  pgPool: Pool,
  schema: string,
  queryText: string,
  limit: number,
): Promise<KeywordResult[]> {
  const result = await pgPool.query<KeywordResult>(
    /* sql */ `
SELECT
  id::int,
  content,
  metadata::text,
  -(content <@> to_bm25query($1, '${schema}.timescale_chunks_content_idx')) as score
 FROM ${schema}.timescale_chunks
 ORDER BY content <@> to_bm25query($1, '${schema}.timescale_chunks_content_idx')
 LIMIT $2
`,
    [queryText, limit],
  );
  return result.rows;
}

async function keywordSearchPostgres(
  pgPool: Pool,
  schema: string,
  queryText: string,
  version: string | null,
  limit: number,
): Promise<KeywordResult[]> {
  const result = await pgPool.query<KeywordResult>(
    /* sql */ `
SELECT
  c.id::int,
  c.content,
  c.metadata::text,
  -(c.content <@> to_bm25query($1, '${schema}.postgres_chunks_content_idx')) as score
 FROM ${schema}.postgres_chunks c
 JOIN ${schema}.postgres_pages p ON c.page_id = p.id
 WHERE p.version = $2
 ORDER BY c.content <@> to_bm25query($1, '${schema}.postgres_chunks_content_idx')
 LIMIT $3
`,
    [queryText, version, limit],
  );
  return result.rows;
}

async function keywordSearchPostgis(
  pgPool: Pool,
  schema: string,
  queryText: string,
  limit: number,
): Promise<KeywordResult[]> {
  const result = await pgPool.query<KeywordResult>(
    /* sql */ `
SELECT
  id::int,
  content,
  metadata::text,
  -(content <@> to_bm25query($1, '${schema}.postgis_chunks_content_idx')) as score
 FROM ${schema}.postgis_chunks
 ORDER BY content <@> to_bm25query($1, '${schema}.postgis_chunks_content_idx')
 LIMIT $2
`,
    [queryText, limit],
  );
  return result.rows;
}

export async function semanticSearchBySource(
  source: DocsSource,
  pgPool: Pool,
  schema: string,
  embeddingJson: string,
  version: string | null,
  limit: number,
): Promise<SemanticResult[]> {
  switch (source) {
    case 'tiger':
      return semanticSearchTiger(pgPool, schema, embeddingJson, limit);
    case 'postgres':
      return semanticSearchPostgres(
        pgPool,
        schema,
        embeddingJson,
        version,
        limit,
      );
    case 'postgis':
      return semanticSearchPostgis(pgPool, schema, embeddingJson, limit);
    default: {
      const _exhaustive: never = source;
      throw new Error(`Unsupported source: ${_exhaustive}`);
    }
  }
}

export async function keywordSearchBySource(
  source: DocsSource,
  pgPool: Pool,
  schema: string,
  queryText: string,
  version: string | null,
  limit: number,
): Promise<KeywordResult[]> {
  switch (source) {
    case 'tiger':
      return keywordSearchTiger(pgPool, schema, queryText, limit);
    case 'postgres':
      return keywordSearchPostgres(pgPool, schema, queryText, version, limit);
    case 'postgis':
      return keywordSearchPostgis(pgPool, schema, queryText, limit);
    default: {
      const _exhaustive: never = source;
      throw new Error(`Unsupported source: ${_exhaustive}`);
    }
  }
}
