import type { Pool } from 'pg';
import type { KeywordResult, SemanticResult } from './schemas.js';

/** Semantic (vector) search — one template; join pages only when `version` is set. */
export async function searchSemantic(
  pgPool: Pool,
  schema: string,
  entity: string,
  embeddingJson: string,
  version: string | null,
  limit: number,
): Promise<SemanticResult[]> {
  const join =
    version != null
      ? /* sql */ `JOIN ${schema}.${entity}_pages p ON c.page_id = p.id WHERE p.version = $2`
      : '';
  const limitSlot = version != null ? '$3' : '$2';
  const sql = /* sql */ `
SELECT
  c.id::int,
  c.content,
  c.metadata::text,
  c.embedding <=> $1::vector(1536) AS distance
FROM ${schema}.${entity}_chunks c
${join}
ORDER BY distance
LIMIT ${limitSlot}
`;
  const values =
    version != null ? [embeddingJson, version, limit] : [embeddingJson, limit];
  const result = await pgPool.query<SemanticResult>(sql, values);
  return result.rows;
}

/** Keyword (BM25) search — same join rule as semantic. */
export async function searchKeyword(
  pgPool: Pool,
  schema: string,
  entity: string,
  queryText: string,
  version: string | null,
  limit: number,
): Promise<KeywordResult[]> {
  const idx = `${schema}.${entity}_chunks_content_idx`;
  const join =
    version != null
      ? /* sql */ `JOIN ${schema}.${entity}_pages p ON c.page_id = p.id WHERE p.version = $2`
      : '';
  const limitSlot = version != null ? '$3' : '$2';
  const sql = /* sql */ `
SELECT
  c.id::int,
  c.content,
  c.metadata::text,
  -(c.content <@> to_bm25query($1, '${idx}')) AS score
FROM ${schema}.${entity}_chunks c
${join}
ORDER BY c.content <@> to_bm25query($1, '${idx}')
LIMIT ${limitSlot}
`;
  const values =
    version != null ? [queryText, version, limit] : [queryText, limit];
  const result = await pgPool.query<KeywordResult>(sql, values);
  return result.rows;
}
