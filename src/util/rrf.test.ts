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
    const semanticIds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const keywordIds = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    const limit = 5;
    const implicit = rrf({
      semanticIds,
      keywordIds,
      limit,
    });
    const explicit = rrf({
      semanticIds,
      keywordIds,
      limit,
      k: DEFAULT_RRF_K,
      semanticWeight: DEFAULT_RRF_SEMANTIC_WEIGHT,
    });
    expect(implicit).toEqual(explicit);
  });
});

describe('rrf()', () => {
  test('prefers id that appears high in both lists', () => {
    const top = rrf({
      semanticIds: [1, 3, 4, 5, 6, 7, 8, 9, 10],
      keywordIds: [2, 1, 11, 12, 13, 14, 15, 16, 17, 18],
      limit: 2,
    });
    expect(top).toHaveLength(2);
    expect(top.map((t) => t.id)).toEqual([1, 2]);
  });

  test('semanticWeight 1 ignores keyword ordering', () => {
    const top = rrf({
      semanticIds: [9, 8, 7, 6, 5, 4, 3, 2, 1],
      keywordIds: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      semanticWeight: 1,
      limit: 2,
    });
    expect(top).toHaveLength(2);
    expect(top.map((t) => t.id)).toEqual([9, 8]);
  });

  test('semanticWeight 0 ignores semantic ordering', () => {
    const top = rrf({
      semanticIds: [9, 8, 7, 6, 5, 4, 3, 2, 1],
      keywordIds: [8, 9, 7, 6, 5, 4, 3, 2, 1],
      semanticWeight: 0,
      limit: 2,
    });
    expect(top).toHaveLength(2);
    expect(top.map((t) => t.id)).toEqual([8, 9]);
  });

  test('orders by fused score descending when only semantic list contributes', () => {
    const top = rrf({
      semanticIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      keywordIds: [],
      semanticWeight: 1,
      limit: 3,
    });
    expect(top).toHaveLength(3);
    expect(top.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(top[0]?.rrf_score).toBeGreaterThan(top[1]?.rrf_score ?? 0);
    expect(top[1]?.rrf_score).toBeGreaterThan(top[2]?.rrf_score ?? 0);
  });

  test('returns only top `limit` when many more unique ids exist across both lists', () => {
    const semanticIds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const keywordIds = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    const top = rrf({
      semanticIds,
      keywordIds,
      limit: 5,
      semanticWeight: 0.5,
    });
    expect(top).toHaveLength(5);
    expect(top.map((t) => t.id)).toEqual([1, 11, 2, 12, 3]);
    for (let i = 0; i < top.length - 1; i++) {
      expect(top[i]?.rrf_score).toBeGreaterThanOrEqual(top[i + 1]?.rrf_score ?? 0);
    }
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
