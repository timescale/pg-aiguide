import { describe, expect, it } from 'bun:test';
import type { Pool } from 'pg';
import { searchKeyword, searchSemantic } from './queries.js';

function createRecordingPool() {
  const calls: { text: string; values: unknown[] }[] = [];
  const pool = {
    query: async <T>(text: string, values?: unknown[]) => {
      calls.push({ text, values: values ?? [] });
      return { rows: [] as T[] };
    },
  } as unknown as Pool;
  return { pool, calls };
}

describe('searchSemantic', () => {
  it('timescale: no join when version is null', async () => {
    const { pool, calls } = createRecordingPool();
    await searchSemantic(pool, 'docs', 'timescale', '[0.1,0.2]', null, 7);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain('docs.timescale_chunks');
    expect(calls[0]?.text).not.toContain('JOIN');
    expect(calls[0]?.text).toContain('<=>');
    expect(calls[0]?.values).toEqual(['[0.1,0.2]', 7]);
  });

  it('postgres: join and version when set', async () => {
    const { pool, calls } = createRecordingPool();
    await searchSemantic(pool, 'docs', 'postgres', '[0]', '16', 5);
    expect(calls[0]?.text).toContain('postgres_chunks');
    expect(calls[0]?.text).toContain('postgres_pages');
    expect(calls[0]?.text).toContain('p.version = $2');
    expect(calls[0]?.values).toEqual(['[0]', '16', 5]);
  });

  it('postgis: all chunks when version null', async () => {
    const { pool, calls } = createRecordingPool();
    await searchSemantic(pool, 'docs', 'postgis', '[]', null, 2);
    expect(calls[0]?.text).toContain('postgis_chunks');
    expect(calls[0]?.text).not.toContain('JOIN');
    expect(calls[0]?.values).toEqual(['[]', 2]);
  });

  it('postgis: join when version set', async () => {
    const { pool, calls } = createRecordingPool();
    await searchSemantic(pool, 'docs', 'postgis', '[1]', '3.4', 3);
    expect(calls[0]?.text).toContain('postgis_pages');
    expect(calls[0]?.values).toEqual(['[1]', '3.4', 3]);
  });
});

describe('searchKeyword', () => {
  it('timescale: bm25, no join', async () => {
    const { pool, calls } = createRecordingPool();
    await searchKeyword(pool, 'docs', 'timescale', 'foo bar', null, 8);
    expect(calls[0]?.text).toContain('to_bm25query');
    expect(calls[0]?.text).toContain('docs.timescale_chunks');
    expect(calls[0]?.values).toEqual(['foo bar', 8]);
  });

  it('postgres: bm25 with version', async () => {
    const { pool, calls } = createRecordingPool();
    await searchKeyword(pool, 'docs', 'postgres', 'sql', '17', 4);
    expect(calls[0]?.text).toContain('postgres_chunks');
    expect(calls[0]?.values).toEqual(['sql', '17', 4]);
  });

  it('postgis: no join when version null', async () => {
    const { pool, calls } = createRecordingPool();
    await searchKeyword(pool, 'docs', 'postgis', 'geom', null, 3);
    expect(calls[0]?.text).not.toContain('JOIN');
    expect(calls[0]?.values).toEqual(['geom', 3]);
  });

  it('postgis: join when version set', async () => {
    const { pool, calls } = createRecordingPool();
    await searchKeyword(pool, 'docs', 'postgis', 'x', '3.5', 2);
    expect(calls[0]?.text).toContain('postgis_pages');
    expect(calls[0]?.values).toEqual(['x', '3.5', 2]);
  });
});
