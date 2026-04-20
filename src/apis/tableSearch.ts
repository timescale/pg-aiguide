import type { Pool } from 'pg';

/** Same inputs as original inlined `search_docs` (pool + schema + entityPrefix + version + search). */
export type TableSearchContext = {
  pool: Pool;
  schema: string;
  entityPrefix: string;
  version?: string;
  semantic: boolean;
  searchParam: string;
  limit: number;
};

export type SemanticChunkRow = {
  id: number;
  content: string;
  metadata: string;
  distance: number;
};

export type KeywordChunkRow = {
  id: number;
  content: string;
  metadata: string;
  score: number;
};

export async function tableSearch(
  ctx: TableSearchContext,
): Promise<SemanticChunkRow[] | KeywordChunkRow[]> {
  const { pool, schema, entityPrefix, semantic, searchParam, limit } = ctx;
  const version = ctx.version;
  const chunks = `${schema}.${entityPrefix}_chunks`;
  const bm25Idx = `${schema}.${entityPrefix}_chunks_content_idx`;
  const pages = `${schema}.${entityPrefix}_pages`;

  const params = [searchParam, ...(version ? [version] : []), limit];

  const sql = /* sql */ `
        SELECT
          c.id::int,
          c.content,
          c.metadata::text,
          ${
            semantic
              ? `c.embedding <=> $1::vector(1536) AS distance`
              : `  -(c.content <@> to_bm25query($1, '${bm25Idx}')) as score`
          }
        FROM ${chunks} c
        ${
          version
            ? `JOIN ${pages} p ON c.page_id = p.id
        WHERE p.version = $2`
            : ``
        }
        ORDER BY ${semantic ? 'distance' : `c.content <@> to_bm25query($1, '${bm25Idx}')`}
        LIMIT $${version ? '3' : '2'}
        `;

  const { rows } = await pool.query(sql, params);
  return rows as SemanticChunkRow[] | KeywordChunkRow[];
}
