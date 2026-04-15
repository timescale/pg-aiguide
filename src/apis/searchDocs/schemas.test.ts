import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  inputSchema,
  zHybridResult,
  zKeywordResult,
  zSemanticResult,
} from './schemas.js';

const searchDocsInput = z.object({
  source: inputSchema.source,
  search_type: inputSchema.search_type,
  query: inputSchema.query,
  limit: inputSchema.limit,
});

describe('searchDocs input schema', () => {
  it('accepts a valid hybrid postgres request', () => {
    const r = searchDocsInput.safeParse({
      source: 'postgres_17',
      search_type: 'hybrid',
      query: 'indexes',
      limit: 5,
    });
    expect(r.success).toBe(true);
  });

  it('rejects invalid source', () => {
    const r = searchDocsInput.safeParse({
      source: 'mysql_8',
      search_type: 'keyword',
      query: 'x',
      limit: 10,
    });
    expect(r.success).toBe(false);
  });

  it('rejects invalid search_type', () => {
    const r = searchDocsInput.safeParse({
      source: 'tiger',
      search_type: 'fulltext',
      query: 'x',
      limit: 10,
    });
    expect(r.success).toBe(false);
  });

  it('coerces limit from string', () => {
    const r = searchDocsInput.safeParse({
      source: 'postgis_3.4',
      search_type: 'semantic',
      query: 'x',
      limit: '3',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.limit).toBe(3);
    }
  });

  it('accepts null limit', () => {
    const r = searchDocsInput.safeParse({
      source: 'postgres_16',
      search_type: 'keyword',
      query: 'x',
      limit: null,
    });
    expect(r.success).toBe(true);
  });
});

describe('result row schemas', () => {
  it('accepts semantic rows with distance', () => {
    const r = zSemanticResult.safeParse({
      id: 1,
      content: 'a',
      metadata: '{}',
      distance: 0.2,
    });
    expect(r.success).toBe(true);
  });

  it('rejects semantic row without distance', () => {
    const r = zSemanticResult.safeParse({
      id: 1,
      content: 'a',
      metadata: '{}',
    });
    expect(r.success).toBe(false);
  });

  it('accepts keyword rows with score', () => {
    const r = zKeywordResult.safeParse({
      id: 1,
      content: 'a',
      metadata: '{}',
      score: 1.5,
    });
    expect(r.success).toBe(true);
  });

  it('accepts hybrid rows with rrf_score', () => {
    const r = zHybridResult.safeParse({
      id: 1,
      content: 'a',
      metadata: '{}',
      rrf_score: 0.03,
    });
    expect(r.success).toBe(true);
  });

  it('rejects hybrid row with distance instead of rrf_score', () => {
    const r = zHybridResult.safeParse({
      id: 1,
      content: 'a',
      metadata: '{}',
      distance: 0.1,
    });
    expect(r.success).toBe(false);
  });
});
