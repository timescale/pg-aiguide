import type { Pool } from 'pg';
import type {
  DocsBaseSource,
  KeywordResult,
  SemanticResult,
} from './schemas.js';

/** DB table prefix: Tiger docs live in timescale_* tables. */
export const ENTITY_NAME_MAPPINGS: Record<DocsBaseSource, string> = {
  tiger: 'timescale',
  postgres: 'postgres',
  postgis: 'postgis',
};

function entityPrefix(base: DocsBaseSource): string {
  return ENTITY_NAME_MAPPINGS[base];
}

async function semanticSearch(
  pgPool: Pool,
  schema: string,
  base: DocsBaseSource,
  embeddingJson: string,
  version: string | null,
  limit: number,
): Promise<SemanticResult[]> {
  const ent = entityPrefix(base);

  if (base === 'tiger') {
    const result = await pgPool.query<SemanticResult>(
      /* sql */ `
SELECT
  id::int,
  content,
  metadata::text,
  embedding <=> $1::vector(1536) AS distance
 FROM ${schema}.${ent}_chunks
 ORDER BY distance
 LIMIT $2
`,
      [embeddingJson, limit],
    );
    return result.rows;
  }

  if (version == null) {
    const result = await pgPool.query<SemanticResult>(
      /* sql */ `
SELECT
  c.id::int,
  c.content,
  c.metadata::text,
  c.embedding <=> $1::vector(1536) AS distance
 FROM ${schema}.${ent}_chunks c
 ORDER BY distance
 LIMIT $2
`,
      [embeddingJson, limit],
    );
    return result.rows;
  }

  const result = await pgPool.query<SemanticResult>(
    /* sql */ `
SELECT
  c.id::int,
  c.content,
  c.metadata::text,
  c.embedding <=> $1::vector(1536) AS distance
 FROM ${schema}.${ent}_chunks c
 JOIN ${schema}.${ent}_pages p ON c.page_id = p.id
 WHERE p.version = $2
 ORDER BY distance
 LIMIT $3
`,
    [embeddingJson, version, limit],
  );
  return result.rows;
}

async function keywordSearch(
  pgPool: Pool,
  schema: string,
  base: DocsBaseSource,
  queryText: string,
  version: string | null,
  limit: number,
): Promise<KeywordResult[]> {
  const ent = entityPrefix(base);
  const idx = `${schema}.${ent}_chunks_content_idx`;

  if (base === 'tiger') {
    const result = await pgPool.query<KeywordResult>(
      /* sql */ `
SELECT
  id::int,
  content,
  metadata::text,
  -(content <@> to_bm25query($1, '${idx}')) as score
 FROM ${schema}.${ent}_chunks
 ORDER BY content <@> to_bm25query($1, '${idx}')
 LIMIT $2
`,
      [queryText, limit],
    );
    return result.rows;
  }

  if (version == null) {
    const result = await pgPool.query<KeywordResult>(
      /* sql */ `
SELECT
  c.id::int,
  c.content,
  c.metadata::text,
  -(c.content <@> to_bm25query($1, '${idx}')) as score
 FROM ${schema}.${ent}_chunks c
 ORDER BY c.content <@> to_bm25query($1, '${idx}')
 LIMIT $2
`,
      [queryText, limit],
    );
    return result.rows;
  }

  const result = await pgPool.query<KeywordResult>(
    /* sql */ `
SELECT
  c.id::int,
  c.content,
  c.metadata::text,
  -(c.content <@> to_bm25query($1, '${idx}')) as score
 FROM ${schema}.${ent}_chunks c
 JOIN ${schema}.${ent}_pages p ON c.page_id = p.id
 WHERE p.version = $2
 ORDER BY c.content <@> to_bm25query($1, '${idx}')
 LIMIT $3
`,
    [queryText, version, limit],
  );
  return result.rows;
}

export async function semanticSearchBySource(
  base: DocsBaseSource,
  pgPool: Pool,
  schema: string,
  embeddingJson: string,
  version: string | null,
  limit: number,
): Promise<SemanticResult[]> {
  return semanticSearch(pgPool, schema, base, embeddingJson, version, limit);
}

export async function keywordSearchBySource(
  base: DocsBaseSource,
  pgPool: Pool,
  schema: string,
  queryText: string,
  version: string | null,
  limit: number,
): Promise<KeywordResult[]> {
  return keywordSearch(pgPool, schema, base, queryText, version, limit);
}
