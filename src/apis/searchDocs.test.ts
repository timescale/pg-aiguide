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
        semanticWeight: 0,
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
        semanticWeight: 0,
        query: '  ',
        limit: 5,
      }),
    ).rejects.toThrow('Query must be a non-empty string.');
  });

  test('rejects invalid source (empty before first underscore)', async () => {
    const pool = poolMock(() => ({ rows: [] }));
    await expect(
      invoke(pool, {
        source: '_postgres',
        semanticWeight: 0,
        query: 'x',
        limit: 1,
      }),
    ).rejects.toThrow('Invalid source');
  });
});

// ---------------------------------------------------------------------------
// Defaults and empty-like inputs (must match SEARCH_DOCS_* in searchDocs.ts)
// ---------------------------------------------------------------------------

describe('search_docs — defaults and empty-like inputs', () => {
  const DEFAULT_LIMIT = 20;
  const DEFAULT_SEMANTIC_WEIGHT = 0.7;
  const HYBRID_POOL_FACTOR = 4;

  test('null limit uses default on keyword path', async () => {
    let lastParams: unknown[] = [];
    const pool = poolMock((_sql, params) => {
      lastParams = params;
      return { rows: [] };
    });
    await invoke(pool, {
      source: 'tiger',
      semanticWeight: 0,
      query: 'wal',
      limit: null,
    });
    expect(lastParams[1]).toBe(DEFAULT_LIMIT);
  });

  test('omitted limit uses default on keyword path', async () => {
    let lastParams: unknown[] = [];
    const pool = poolMock((_sql, params) => {
      lastParams = params;
      return { rows: [] };
    });
    await invoke(pool, {
      source: 'tiger',
      semanticWeight: 0,
      query: 'wal',
    });
    expect(lastParams[1]).toBe(DEFAULT_LIMIT);
  });

  test('empty-string limit coerces to 0 and is rejected', async () => {
    const pool = poolMock(() => ({ rows: [] }));
    await expect(
      invoke(pool, {
        source: 'tiger',
        semanticWeight: 0,
        query: 'x',
        limit: '',
      }),
    ).rejects.toThrow('Limit must be a positive integer.');
  });

  test('null semanticWeight uses default hybrid (two queries)', async () => {
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
      semanticWeight: null,
      query: 'compression',
      limit: 5,
    })) as { results: { id: number; rrf_score: number }[] };

    expect(queries).toBe(2);
    expect(out.results).toHaveLength(2);
    expect(out.results.map((r) => r.id)).toEqual([100, 200]);
    expect(out.results[0]?.rrf_score).toBeCloseTo(
      DEFAULT_SEMANTIC_WEIGHT / (60 + 1),
      10,
    );
    expect(out.results[1]?.rrf_score).toBeCloseTo(
      (1 - DEFAULT_SEMANTIC_WEIGHT) / (60 + 1),
      10,
    );
  });

  test('omitted semanticWeight uses default hybrid (two queries)', async () => {
    let queries = 0;
    const pool = poolMock((sql) => {
      queries += 1;
      if (sql.includes('<=>')) {
        return {
          rows: [{ id: 1, content: 'a', metadata: '{}', distance: 0.1 }],
        };
      }
      return { rows: [{ id: 2, content: 'b', metadata: '{}', score: 1.0 }] };
    });

    await invoke(pool, {
      source: 'tiger',
      query: 'q',
      limit: 3,
    });

    expect(queries).toBe(2);
  });

  test('null limit and null semanticWeight use defaults for hybrid pool size', async () => {
    let keywordLimit = 0;
    const pool = poolMock((sql, params) => {
      if (!sql.includes('<=>')) {
        keywordLimit = params[params.length - 1] as number;
      }
      return { rows: [] };
    });

    await invoke(pool, {
      source: 'tiger',
      semanticWeight: null,
      query: 'compression',
      limit: null,
    });

    expect(keywordLimit).toBe(DEFAULT_LIMIT * HYBRID_POOL_FACTOR);
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
      semanticWeight: 0,
      query: 'hello',
      limit: 10,
    })) as { results: unknown[] };

    expect(out.results).toEqual([
      { id: 1, content: 'x', metadata: '{}', score: 1.5 },
    ]);
  });

  test('maps tiger source to timescale chunk table in SQL', async () => {
    let lastSql = '';
    const pool = poolMock((sql) => {
      lastSql = sql;
      return { rows: [] };
    });
    await invoke(pool, {
      source: 'tiger',
      semanticWeight: 0,
      query: 'hello',
      limit: 10,
    });
    expect(lastSql).toContain('doc.timescale_chunks');
  });

  test('passes version bind for versioned postgres source', async () => {
    let lastParams: unknown[] = [];
    const pool = poolMock((_sql, params) => {
      lastParams = params;
      return { rows: [] };
    });
    await invoke(pool, {
      source: 'postgres_16',
      semanticWeight: 0,
      query: 'wal',
      limit: 3,
    });
    expect(lastParams[0]).toBe('wal');
    expect(lastParams[1]).toBe('16');
    expect(lastParams[2]).toBe(3);
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
      semanticWeight: 1,
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
        rows: [
          { id: 200, content: 'b', metadata: '{}', score: 1.0 },
          { id: 100, content: 'a', metadata: '{}', score: 0.9 },
        ],
      };
    });

    const out = (await invoke(pool, {
      source: 'tiger',
      semanticWeight: 0.5,
      query: 'compression',
      limit: 5,
    })) as { results: { id: number; rrf_score: number }[] };

    expect(queries).toBe(2);
    expect(out.results).toHaveLength(2);
    expect(out.results.map((r) => r.id)).toEqual([100, 200]);
    // RRF k=60, semanticWeight 0.5 / keywordWeight 0.5
    const expected100 = 0.5 / (60 + 1) + 0.5 / (60 + 2);
    expect(out.results[0]?.rrf_score).toBeCloseTo(expected100, 10);
    expect(out.results[1]?.rrf_score).toBeCloseTo(0.5 / (60 + 1), 10);
  });
});
