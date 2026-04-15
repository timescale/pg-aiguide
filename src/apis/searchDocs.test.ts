import { describe, expect, mock, test } from 'bun:test';
import type { McpFeatureFlags } from '@tigerdata/mcp-boilerplate';
import type { Pool } from 'pg';

const flags = {} as McpFeatureFlags;

mock.module('ai', () => ({
  embed: mock(() => Promise.resolve({ embedding: new Array(1536).fill(0.02) })),
}));

const { searchDocsFactory } = await import('./searchDocs.js');

function poolMock(
  onQuery: (sql: string, params: unknown[]) => { rows: unknown[] },
): Pool {
  return {
    query: (sql: string, params: unknown[]) =>
      Promise.resolve(onQuery(sql, params)),
  } as unknown as Pool;
}

async function invoke(pool: Pool, args: Record<string, unknown>) {
  const def = await Promise.resolve(
    searchDocsFactory({ pgPool: pool, schema: 'doc' }, flags),
  );
  return (
    def as unknown as {
      fn: (a: Record<string, unknown>) => Promise<unknown>;
    }
  ).fn(args);
}

// ---------------------------------------------------------------------------
// Input validation (no successful DB path)
// ---------------------------------------------------------------------------

describe('search_docs — validation', () => {
  test('rejects non-positive limit', async () => {
    const pool = poolMock(() => ({ rows: [] }));
    await expect(
      invoke(pool, {
        source: 'tiger',
        search_type: 'keyword',
        query: 'x',
        limit: 0,
      }),
    ).rejects.toThrow('Limit must be a positive integer.');
  });

  test('rejects blank query', async () => {
    const pool = poolMock(() => ({ rows: [] }));
    await expect(
      invoke(pool, {
        source: 'tiger',
        search_type: 'keyword',
        query: '  ',
        limit: 5,
      }),
    ).rejects.toThrow('Query must be a non-empty string.');
  });
});

// ---------------------------------------------------------------------------
// Keyword search
// ---------------------------------------------------------------------------

describe('search_docs — keyword', () => {
  test('returns rows from Postgres', async () => {
    const pool = poolMock(() => ({
      rows: [{ id: 1, content: 'x', metadata: '{}', score: 1.5 }],
    }));
    const out = (await invoke(pool, {
      source: 'tiger',
      search_type: 'keyword',
      query: 'hello',
      limit: 10,
    })) as { results: unknown[] };

    expect(out.results).toEqual([
      { id: 1, content: 'x', metadata: '{}', score: 1.5 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Semantic search
// ---------------------------------------------------------------------------

describe('search_docs — semantic', () => {
  test('sends embedding JSON to Postgres and returns rows', async () => {
    const pool = poolMock((_sql, params) => {
      expect(JSON.parse(params[0] as string)).toHaveLength(1536);
      return {
        rows: [{ id: 2, content: 'y', metadata: '{}', distance: 0.3 }],
      };
    });
    const out = (await invoke(pool, {
      source: 'tiger',
      search_type: 'semantic',
      query: 'what is a hypertable',
      limit: 5,
    })) as { results: { distance: number }[] };

    expect(out.results[0]?.distance).toBe(0.3);
  });
});

// ---------------------------------------------------------------------------
// Hybrid search
// ---------------------------------------------------------------------------

describe('search_docs — hybrid', () => {
  test('runs vector + BM25 queries then merges with RRF', async () => {
    let queries = 0;
    const pool = poolMock((sql) => {
      queries += 1;
      if (sql.includes('<=>')) {
        return {
          rows: [{ id: 100, content: 'a', metadata: '{}', distance: 0.1 }],
        };
      }
      return {
        rows: [{ id: 200, content: 'b', metadata: '{}', score: 1.0 }],
      };
    });

    const out = (await invoke(pool, {
      source: 'tiger',
      search_type: 'hybrid',
      query: 'compression',
      limit: 5,
    })) as { results: { id: number; rrf_score: number }[] };

    expect(queries).toBe(2);
    expect(out.results).toHaveLength(2);
    expect(out.results.every((r) => 'rrf_score' in r)).toBe(true);
  });
});
