import { describe, expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { DocChunkSearch } from './docChunkSearch.js';

function capturePool(onQuery: (sql: string, params: unknown[]) => unknown[]): {
  pool: Pool;
  lastSql: () => string;
  lastParams: () => unknown[];
} {
  let sql = '';
  let params: unknown[] = [];
  const pool = {
    query: (q: string, p: unknown[]) => {
      sql = q;
      params = p;
      return Promise.resolve({ rows: onQuery(q, p) });
    },
  } as unknown as Pool;
  return {
    pool,
    lastSql: () => sql,
    lastParams: () => params,
  };
}

describe('DocChunkSearch', () => {
  test('semantic mode uses cosine distance and embedding param', async () => {
    const { pool, lastSql, lastParams } = capturePool(() => []);
    const search = new DocChunkSearch({
      pool,
      schema: 'docs',
      entityPrefix: 'postgres',
    });
    await search.searchSemantic('[0.1]', 7);

    expect(lastSql()).toContain('<=>');
    expect(lastSql()).toContain('vector(1536)');
    expect(lastSql()).toContain('docs.postgres_chunks');
    expect(lastSql()).toContain('ORDER BY distance');
    expect(lastParams()).toEqual(['[0.1]', 7]);
  });

  test('keyword mode uses BM25 operator and query text', async () => {
    const { pool, lastSql, lastParams } = capturePool(() => []);
    const search = new DocChunkSearch({
      pool,
      schema: 'docs',
      entityPrefix: 'timescale',
    });
    await search.searchKeyword('hypertable', 12);

    expect(lastSql()).toContain('<@>');
    expect(lastSql()).not.toContain('<=>');
    expect(lastSql()).toContain('docs.timescale_chunks');
    expect(lastSql()).toContain('to_bm25query($1,');
    expect(lastSql()).toContain('docs.timescale_chunks_content_idx');
    expect(lastSql()).toContain(
      "ORDER BY c.content <@> to_bm25query($1, 'docs.timescale_chunks_content_idx')",
    );
    expect(lastParams()).toEqual(['hypertable', 12]);
  });

  test('version adds page join and version bind', async () => {
    const { pool, lastSql, lastParams } = capturePool(() => []);
    const search = new DocChunkSearch({
      pool,
      schema: 'doc',
      entityPrefix: 'postgis',
      version: '3.4',
    });
    await search.searchKeyword('st_intersects', 3);

    expect(lastSql()).toContain('JOIN doc.postgis_pages p');
    expect(lastSql()).toContain('p.version = $2');
    expect(lastParams()).toEqual(['st_intersects', '3.4', 3]);
  });
});
