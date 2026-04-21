import { describe, expect, test } from 'bun:test';
import { DEFAULT_RRF_K, DEFAULT_RRF_SEMANTIC_WEIGHT, rrf } from './rrf.js';

describe('RRF defaults', () => {
  test('DEFAULT_RRF_K is 60', () => {
    expect(DEFAULT_RRF_K).toBe(60);
  });

  test('DEFAULT_RRF_SEMANTIC_WEIGHT is 0.5 (equal mix with keyword)', () => {
    expect(DEFAULT_RRF_SEMANTIC_WEIGHT).toBe(0.5);
  });

  test('omitting k and semanticWeight matches explicit defaults', () => {
    const implicit = rrf({
      semanticIds: [5],
      keywordIds: [5],
      limit: 10,
    });
    const explicit = rrf({
      semanticIds: [5],
      keywordIds: [5],
      limit: 10,
      k: DEFAULT_RRF_K,
      semanticWeight: DEFAULT_RRF_SEMANTIC_WEIGHT,
    });
    expect(implicit).toEqual(explicit);
  });
});

describe('rrf()', () => {
  test('prefers id that appears high in both lists', () => {
    const top = rrf({
      semanticIds: [1],
      keywordIds: [2, 1],
      limit: 10,
    });
    expect(top.map((t) => t.id)).toEqual([1, 2]);
  });

  test('semanticWeight 1 ignores keyword ordering', () => {
    const top = rrf({
      semanticIds: [9, 8],
      keywordIds: [8, 9],
      semanticWeight: 1,
      limit: 2,
    });
    expect(top.map((t) => t.id)).toEqual([9, 8]);
  });

  test('semanticWeight 0 ignores semantic ordering', () => {
    const top = rrf({
      semanticIds: [9, 8],
      keywordIds: [8, 9],
      semanticWeight: 0,
      limit: 2,
    });
    expect(top.map((t) => t.id)).toEqual([8, 9]);
  });

  test('orders by fused score descending when only semantic list contributes', () => {
    const top = rrf({
      semanticIds: [1, 2, 3],
      keywordIds: [],
      semanticWeight: 1,
      limit: 3,
    });
    expect(top.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(top[0]?.rrf_score).toBeGreaterThan(top[1]?.rrf_score ?? 0);
    expect(top[1]?.rrf_score).toBeGreaterThan(top[2]?.rrf_score ?? 0);
  });

  test('exposes fused score for id in both lists (default k and semanticWeight)', () => {
    const top = rrf({
      semanticIds: [5],
      keywordIds: [5],
      limit: 10,
    });
    const row = top.find((t) => t.id === 5);
    expect(row?.rrf_score).toBeCloseTo(1 / (DEFAULT_RRF_K + 1), 10);
  });

  test('custom k changes fused score', () => {
    const k = 30;
    const top = rrf({
      semanticIds: [5],
      keywordIds: [5],
      limit: 10,
      k,
    });
    expect(top[0]?.rrf_score).toBeCloseTo(1 / (k + 1), 10);
  });
});
