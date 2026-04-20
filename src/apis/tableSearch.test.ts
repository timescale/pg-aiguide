import { describe, expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { tableSearch } from './tableSearch.js';

function poolMock(
  onQuery: (sql: string, params: unknown[]) => { rows: unknown[] },
): Pool {
  return {
    query: (sql: string, params: unknown[]) =>
      Promise.resolve(onQuery(sql, params)),
  } as unknown as Pool;
}

describe('tableSearch', () => {
  test('semantic SQL uses chunks table, vector(1536), distance, LIMIT $2 without version', async () => {
    let sql = '';
    let params: unknown[] = [];
    const pool = poolMock((s, p) => {
      sql = s;
      params = p;
      return { rows: [] };
    });
    await tableSearch({
      pool,
      schema: 'doc',
      entityPrefix: 'timescale',
      semantic: true,
      searchParam: '[]',
      limit: 3,
    });
    expect(sql).toContain('FROM doc.timescale_chunks c');
    expect(sql).toContain('c.embedding <=> $1::vector(1536) AS distance');
    expect(sql).toContain('ORDER BY distance');
    expect(sql).toContain('LIMIT $2');
    expect(sql).not.toContain('_pages');
    expect(params).toEqual(['[]', 3]);
  });

  test('keyword SQL uses chunks table, BM25 index, score, LIMIT $2 without version', async () => {
    let sql = '';
    let params: unknown[] = [];
    const pool = poolMock((s, p) => {
      sql = s;
      params = p;
      return { rows: [] };
    });
    await tableSearch({
      pool,
      schema: 'doc',
      entityPrefix: 'postgres',
      semantic: false,
      searchParam: 'wal',
      limit: 2,
    });
    expect(sql).toContain('FROM doc.postgres_chunks c');
    expect(sql).toContain(
      "to_bm25query($1, 'doc.postgres_chunks_content_idx')",
    );
    expect(sql).toContain('as score');
    expect(sql).toContain('ORDER BY');
    expect(sql).toContain('LIMIT $2');
    expect(sql).not.toContain('_pages');
    expect(params).toEqual(['wal', 2]);
  });

  test('with version adds pages join, version bind, LIMIT $3', async () => {
    let sql = '';
    let params: unknown[] = [];
    const pool = poolMock((s, p) => {
      sql = s;
      params = p;
      return { rows: [] };
    });
    await tableSearch({
      pool,
      schema: 'doc',
      entityPrefix: 'postgres',
      version: '16',
      semantic: false,
      searchParam: 'wal',
      limit: 1,
    });
    expect(sql).toContain('JOIN doc.postgres_pages p ON c.page_id = p.id');
    expect(sql).toContain('WHERE p.version = $2');
    expect(sql).toContain('LIMIT $3');
    expect(params).toEqual(['wal', '16', 1]);
  });

  test('returns semantic rows from pool', async () => {
    const pool = poolMock(() => ({
      rows: [{ id: 1, content: 'c', metadata: '{}', distance: 0.2 }],
    }));
    const rows = await tableSearch({
      pool,
      schema: 'doc',
      entityPrefix: 'timescale',
      semantic: true,
      searchParam: '[0.1]',
      limit: 10,
    });
    expect(rows).toEqual([
      { id: 1, content: 'c', metadata: '{}', distance: 0.2 },
    ]);
  });

  test('returns keyword rows from pool', async () => {
    const pool = poolMock(() => ({
      rows: [{ id: 2, content: 'k', metadata: '{}', score: -1.5 }],
    }));
    const rows = await tableSearch({
      pool,
      schema: 'doc',
      entityPrefix: 'timescale',
      semantic: false,
      searchParam: 'hypertable',
      limit: 5,
    });
    expect(rows).toEqual([
      { id: 2, content: 'k', metadata: '{}', score: -1.5 },
    ]);
  });
});
