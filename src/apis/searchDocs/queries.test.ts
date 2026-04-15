import { describe, expect, it } from 'bun:test';
import type { Pool } from 'pg';
import { keywordSearchBySource, semanticSearchBySource } from './queries.js';

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

describe('semanticSearchBySource', () => {
  it('tiger: timescale_chunks and embedding param', async () => {
    const { pool, calls } = createRecordingPool();
    await semanticSearchBySource('tiger', pool, 'docs', '[0.1,0.2]', null, 7);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain('docs.timescale_chunks');
    expect(calls[0]?.text).toContain('<=>');
    expect(calls[0]?.values).toEqual(['[0.1,0.2]', 7]);
  });

  it('postgres: join, version and limit params', async () => {
    const { pool, calls } = createRecordingPool();
    await semanticSearchBySource('postgres', pool, 'docs', '[0]', '16', 5);
    expect(calls[0]?.text).toContain('postgres_chunks');
    expect(calls[0]?.text).toContain('postgres_pages');
    expect(calls[0]?.text).toContain('p.version = $2');
    expect(calls[0]?.values).toEqual(['[0]', '16', 5]);
  });

  it('postgres: passes null version (no join)', async () => {
    const { pool, calls } = createRecordingPool();
    await semanticSearchBySource('postgres', pool, 'docs', '[]', null, 1);
    expect(calls[0]?.text).not.toContain('JOIN');
    expect(calls[0]?.values).toEqual(['[]', 1]);
  });

  it('postgis: postgis_chunks without version', async () => {
    const { pool, calls } = createRecordingPool();
    await semanticSearchBySource('postgis', pool, 'docs', '[]', null, 2);
    expect(calls[0]?.text).toContain('docs.postgis_chunks');
    expect(calls[0]?.values).toEqual(['[]', 2]);
  });

  it('postgis: join and version when provided', async () => {
    const { pool, calls } = createRecordingPool();
    await semanticSearchBySource('postgis', pool, 'docs', '[1]', '3.4', 3);
    expect(calls[0]?.text).toContain('postgis_pages');
    expect(calls[0]?.text).toContain('p.version = $2');
    expect(calls[0]?.values).toEqual(['[1]', '3.4', 3]);
  });
});

describe('keywordSearchBySource', () => {
  it('tiger: bm25 on timescale_chunks', async () => {
    const { pool, calls } = createRecordingPool();
    await keywordSearchBySource('tiger', pool, 'docs', 'foo bar', null, 8);
    expect(calls[0]?.text).toContain('to_bm25query');
    expect(calls[0]?.text).toContain('docs.timescale_chunks');
    expect(calls[0]?.values).toEqual(['foo bar', 8]);
  });

  it('postgres: bm25 with version', async () => {
    const { pool, calls } = createRecordingPool();
    await keywordSearchBySource('postgres', pool, 'docs', 'sql', '17', 4);
    expect(calls[0]?.text).toContain('postgres_chunks');
    expect(calls[0]?.values).toEqual(['sql', '17', 4]);
  });

  it('postgres: null version (no join)', async () => {
    const { pool, calls } = createRecordingPool();
    await keywordSearchBySource('postgres', pool, 'docs', 'q', null, 1);
    expect(calls[0]?.text).not.toContain('JOIN');
    expect(calls[0]?.values).toEqual(['q', 1]);
  });

  it('postgis: bm25 on postgis_chunks', async () => {
    const { pool, calls } = createRecordingPool();
    await keywordSearchBySource('postgis', pool, 'docs', 'geom', null, 3);
    expect(calls[0]?.text).toContain('postgis_chunks');
    expect(calls[0]?.values).toEqual(['geom', 3]);
  });

  it('postgis: bm25 with version filter', async () => {
    const { pool, calls } = createRecordingPool();
    await keywordSearchBySource('postgis', pool, 'docs', 'x', '3.5', 2);
    expect(calls[0]?.text).toContain('postgis_pages');
    expect(calls[0]?.values).toEqual(['x', '3.5', 2]);
  });
});
