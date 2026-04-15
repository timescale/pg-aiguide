import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { McpFeatureFlags } from '@tigerdata/mcp-boilerplate';
import type { Pool } from 'pg';
import { latest_pg_version } from './schemas.js';

const featureFlags = {} as McpFeatureFlags;

const searchSemantic = mock(
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

const searchKeyword = mock(
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
  searchSemantic,
  searchKeyword,
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
    searchSemantic.mockClear();
    searchKeyword.mockClear();
  });

  it('keyword search does not call embed', async () => {
    await api.fn({
      source: 'tiger',
      search_type: 'keyword',
      query: 'hello',
      limit: 10,
    });
    expect(embed).not.toHaveBeenCalled();
    expect(searchSemantic).not.toHaveBeenCalled();
    expect(searchKeyword).toHaveBeenCalledTimes(1);
    expect(searchKeyword).toHaveBeenCalledWith(
      pool,
      'docs',
      'timescale',
      'hello',
      null,
      10,
    );
  });

  it('semantic search calls embed once and searchSemantic', async () => {
    await api.fn({
      source: 'postgis_3.4',
      search_type: 'semantic',
      query: 'types',
      limit: 5,
    });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(searchKeyword).not.toHaveBeenCalled();
    expect(searchSemantic).toHaveBeenCalledTimes(1);
    expect(searchSemantic).toHaveBeenCalledWith(
      pool,
      'docs',
      'postgis',
      expect.any(String),
      '3.4',
      5,
    );
  });

  it('resolves postgres_latest to latest_pg_version', async () => {
    await api.fn({
      source: 'postgres_latest',
      search_type: 'keyword',
      query: 'x',
      limit: 1,
    });
    expect(searchKeyword).toHaveBeenCalledWith(
      pool,
      'docs',
      'postgres',
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
      limit: 10,
    });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(searchSemantic).toHaveBeenCalledWith(
      pool,
      'docs',
      'timescale',
      expect.any(String),
      null,
      60,
    );
    expect(searchKeyword).toHaveBeenCalledWith(
      pool,
      'docs',
      'timescale',
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
        limit: 10,
      }),
    ).rejects.toThrow('Query must be a non-empty string.');
  });

  it('uses limit 10 when passed limit is null', async () => {
    await api.fn({
      source: 'tiger',
      search_type: 'keyword',
      query: 'q',
      limit: null,
    });
    expect(searchKeyword).toHaveBeenCalledWith(
      pool,
      'docs',
      'timescale',
      'q',
      null,
      10,
    );
  });

  it('rejects non-positive limit', async () => {
    await expect(
      api.fn({
        source: 'tiger',
        search_type: 'keyword',
        query: 'q',
        limit: 0,
      }),
    ).rejects.toThrow('Limit must be a positive integer.');
  });
});
