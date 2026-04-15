import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { McpFeatureFlags } from '@tigerdata/mcp-boilerplate';
import type { Pool } from 'pg';
import { latest_pg_version } from './schemas.js';

const featureFlags = {} as McpFeatureFlags;

const semanticSearchBySource = mock(
  async () =>
    [
      {
        id: 1,
        content: 'sem',
        metadata: '{}',
        distance: 0.1,
      },
    ] as const,
);

const keywordSearchBySource = mock(
  async () =>
    [
      {
        id: 2,
        content: 'kw',
        metadata: '{}',
        score: 2,
      },
    ] as const,
);

mock.module('./queries.js', () => ({
  semanticSearchBySource,
  keywordSearchBySource,
}));

const embed = mock(async () => ({
  embedding: new Array(1536).fill(0.02),
}));

mock.module('ai', () => ({
  embed,
}));

mock.module('@ai-sdk/openai', () => ({
  openai: {
    embedding: (_id: string) => ({}),
  },
}));

const { searchDocsFactory } = await import('./index.js');

const pool = {} as unknown as Pool;

const api = await Promise.resolve(
  searchDocsFactory({ pgPool: pool, schema: 'docs' }, featureFlags),
);

describe('searchDocsFactory fn', () => {
  beforeEach(() => {
    embed.mockClear();
    semanticSearchBySource.mockClear();
    keywordSearchBySource.mockClear();
  });

  it('keyword search does not call embed', async () => {
    await api.fn({
      source: 'tiger',
      search_type: 'keyword',
      query: 'hello',
      version: null,
      limit: 10,
    });
    expect(embed).not.toHaveBeenCalled();
    expect(semanticSearchBySource).not.toHaveBeenCalled();
    expect(keywordSearchBySource).toHaveBeenCalledTimes(1);
    expect(keywordSearchBySource).toHaveBeenCalledWith(
      'tiger',
      pool,
      'docs',
      'hello',
      null,
      10,
    );
  });

  it('semantic search calls embed once and semanticSearchBySource', async () => {
    await api.fn({
      source: 'postgis',
      search_type: 'semantic',
      query: 'types',
      version: null,
      limit: 5,
    });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(keywordSearchBySource).not.toHaveBeenCalled();
    expect(semanticSearchBySource).toHaveBeenCalledTimes(1);
    expect(semanticSearchBySource).toHaveBeenCalledWith(
      'postgis',
      pool,
      'docs',
      expect.any(String),
      null,
      5,
    );
  });

  it('resolves version latest to latest_pg_version for postgres', async () => {
    await api.fn({
      source: 'postgres',
      search_type: 'keyword',
      query: 'x',
      version: 'latest',
      limit: 1,
    });
    expect(keywordSearchBySource).toHaveBeenCalledWith(
      'postgres',
      pool,
      'docs',
      'x',
      latest_pg_version,
      1,
    );
  });

  it('hybrid uses candLimit max(limit * 4, 60) and mergeRrf', async () => {
    const out = await api.fn({
      source: 'tiger',
      search_type: 'hybrid',
      query: 'both',
      version: null,
      limit: 10,
    });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(semanticSearchBySource).toHaveBeenCalledWith(
      'tiger',
      pool,
      'docs',
      expect.any(String),
      null,
      60,
    );
    expect(keywordSearchBySource).toHaveBeenCalledWith(
      'tiger',
      pool,
      'docs',
      'both',
      null,
      60,
    );
    expect(out.results.length).toBeGreaterThan(0);
    expect(out.results[0]).toHaveProperty('rrf_score');
  });

  it('rejects empty query', async () => {
    await expect(
      api.fn({
        source: 'tiger',
        search_type: 'keyword',
        query: '   ',
        version: null,
        limit: 10,
      }),
    ).rejects.toThrow('Query must be a non-empty string.');
  });

  it('uses limit 10 when passed limit is 0', async () => {
    await api.fn({
      source: 'tiger',
      search_type: 'keyword',
      query: 'q',
      version: null,
      limit: 0,
    });
    expect(keywordSearchBySource).toHaveBeenCalledWith(
      'tiger',
      pool,
      'docs',
      'q',
      null,
      10,
    );
  });
});
