import type { Pool } from 'pg';

export type DocChunkSearchContext = {
  pool: Pool;
  schema: string;
  entityPrefix: string;
  version?: string;
};

/** Row shape for `searchSemantic` / vector leg of hybrid (matches SELECT aliases). */
export type DocChunkSemanticRow = {
  id: number;
  content: string;
  metadata: string;
  distance: number;
};

/** Row shape for `searchKeyword` / BM25 leg of hybrid (matches SELECT aliases). */
export type DocChunkKeywordRow = {
  id: number;
  content: string;
  metadata: string;
  score: number;
};

/**
 * Top-k search over documentation chunks: separate entry points for vector
 * similarity vs BM25 so each caller passes only the argument that search needs.
 */
export class DocChunkSearch {
  constructor(private readonly ctx: DocChunkSearchContext) {}

  /** Vector similarity; `embeddingJson` is the serialized embedding for `$1::vector(1536)`. */
  searchSemantic(
    embeddingJson: string,
    limit: number,
  ): Promise<DocChunkSemanticRow[]> {
    return this.runSearch(true, embeddingJson, limit) as Promise<
      DocChunkSemanticRow[]
    >;
  }

  /** BM25 keyword search; `query` is passed to `to_bm25query` with the content index. */
  searchKeyword(
    query: string,
    limit: number,
  ): Promise<DocChunkKeywordRow[]> {
    return this.runSearch(false, query, limit) as Promise<DocChunkKeywordRow[]>;
  }

  private async runSearch(
    semantic: boolean,
    searchParam: string,
    limit: number,
  ): Promise<DocChunkSemanticRow[] | DocChunkKeywordRow[]> {
    const { pool, schema, entityPrefix, version } = this.ctx;
    const bm25Idx = `${schema}.${entityPrefix}_chunks_content_idx`;

    const sql = /* sql */ `
        SELECT
          c.id::int,
          c.content,
          c.metadata::text,
          ${
            semantic
              ? `c.embedding <=> $1::vector(1536) AS distance`
              : `-(c.content <@> to_bm25query($1, '${bm25Idx}')) AS score`
          }
        FROM ${schema}.${entityPrefix}_chunks c
        ${
          version
            ? `JOIN ${schema}.${entityPrefix}_pages p ON c.page_id = p.id
        WHERE p.version = $2`
            : ``
        }
        ORDER BY ${
          semantic
            ? 'distance'
            : `c.content <@> to_bm25query($1, '${bm25Idx}')`
        }
        LIMIT $${version ? '3' : '2'}
        `;

    const result = await pool.query(sql, [
      searchParam,
      ...(version ? [version] : []),
      limit,
    ]);
    return result.rows as DocChunkSemanticRow[] | DocChunkKeywordRow[];
  }
}
