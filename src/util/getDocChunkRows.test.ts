import { describe, expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { getDocChunkRows } from './getDocChunkRows.js';

function poolMock(
  onQuery: (sql: string, params: unknown[]) => { rows: unknown[] },
): Pool {
  return {
    query: (sql: string, params: unknown[]) =>
      Promise.resolve(onQuery(sql, params)),
  } as unknown as Pool;
}

describe('getDocChunkRows', () => {
  test('semantic SQL uses chunks table, vector(1536), distance, LIMIT $2 without version', async () => {
    let sql = '';
    let params: unknown[] = [];
    const pgPool = poolMock((s, p) => {
      sql = s;
      params = p;
      return { rows: [] };
    });
    await getDocChunkRows({
      pgPool,
      schema: 'doc',
      entityPrefix: 'timescale',
      version: null,
      semantic: true,
      searchParam: '[]',
      limit: 3,
    });
    expect(sql).toBe(`
        SELECT
          c.id::int,
          c.content,
          c.metadata::text,
          c.embedding <=> $1::vector(1536) AS distance
        FROM doc.timescale_chunks c
        
        ORDER BY distance
        LIMIT $2
        `);
  });

  test('semantic SQL with version: pages join, version bind, ORDER BY distance, LIMIT $3', async () => {
    let sql = '';
    let params: unknown[] = [];
    const pgPool = poolMock((s, p) => {
      sql = s;
      params = p;
      return { rows: [] };
    });
    await getDocChunkRows({
      pgPool,
      schema: 'doc',
      entityPrefix: 'postgres',
      version: '18',
      semantic: true,
      searchParam: '[]',
      limit: 4,
    });
    expect(sql).toBe(`
        SELECT
          c.id::int,
          c.content,
          c.metadata::text,
          c.embedding <=> $1::vector(1536) AS distance
        FROM doc.postgres_chunks c
        JOIN doc.postgres_pages p ON c.page_id = p.id
        WHERE p.version = $2
        ORDER BY distance
        LIMIT $3
        `);
  });

  test('keyword SQL uses chunks table, BM25 index, score, LIMIT $2 without version', async () => {
    let sql = '';
    let params: unknown[] = [];
    const pgPool = poolMock((s, p) => {
      sql = s;
      params = p;
      return { rows: [] };
    });
    await getDocChunkRows({
      pgPool,
      schema: 'doc',
      entityPrefix: 'postgres',
      version: null,
      semantic: false,
      searchParam: 'wal',
      limit: 2,
    });
    expect(sql).toBe(`
        SELECT
          c.id::int,
          c.content,
          c.metadata::text,
            -(c.content <@> to_bm25query($1, 'doc.postgres_chunks_content_idx')) as score
        FROM doc.postgres_chunks c
        
        ORDER BY c.content <@> to_bm25query($1, 'doc.postgres_chunks_content_idx')
        LIMIT $2
        `);
  });

  test('with version adds pages join, version bind, LIMIT $3', async () => {
    let sql = '';
    let params: unknown[] = [];
    const pgPool = poolMock((s, p) => {
      sql = s;
      params = p;
      return { rows: [] };
    });
    await getDocChunkRows({
      pgPool,
      schema: 'doc',
      entityPrefix: 'postgres',
      version: '16',
      semantic: false,
      searchParam: 'wal',
      limit: 1,
    });
    expect(sql).toBe(`
        SELECT
          c.id::int,
          c.content,
          c.metadata::text,
            -(c.content <@> to_bm25query($1, 'doc.postgres_chunks_content_idx')) as score
        FROM doc.postgres_chunks c
        JOIN doc.postgres_pages p ON c.page_id = p.id
        WHERE p.version = $2
        ORDER BY c.content <@> to_bm25query($1, 'doc.postgres_chunks_content_idx')
        LIMIT $3
        `);
  });
});
