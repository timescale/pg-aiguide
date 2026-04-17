import { describe, expect, test } from 'bun:test';
import { DEFAULT_RRF_K, RrfFusion } from './rrf.js';

describe('RrfFusion', () => {
  test('DEFAULT_RRF_K is 60', () => {
    expect(DEFAULT_RRF_K).toBe(60);
  });

  test('rankedTop prefers id that appears high in both lists', () => {
    const fusion = new RrfFusion(60, {
      keywordWeight: 1,
      semanticWeight: 1,
    });
    // id 1 only in semantic rank 1; id 2 keyword rank 1 only. id 1 also keyword rank 2.
    const top = fusion.rankedTop([1], [2, 1], 10);
    expect(top.map((t) => t.id)).toEqual([1, 2]);
  });

  test('zero keyword weight ignores keyword ordering', () => {
    const onlySemantic = new RrfFusion(60, {
      keywordWeight: 0,
      semanticWeight: 1,
    });
    const top = onlySemantic.rankedTop([9, 8], [8, 9], 2);
    expect(top.map((t) => t.id)).toEqual([9, 8]);
  });

  test('zero semantic weight ignores semantic ordering', () => {
    const onlyKeyword = new RrfFusion(60, {
      keywordWeight: 1,
      semanticWeight: 0,
    });
    const top = onlyKeyword.rankedTop([9, 8], [8, 9], 2);
    expect(top.map((t) => t.id)).toEqual([8, 9]);
  });

  test('topIds sorts by score descending', () => {
    const m = new Map<number, number>([
      [1, 0.01],
      [2, 0.05],
      [3, 0.02],
    ]);
    const top = RrfFusion.topIds(m, 2);
    expect(top.map((t) => t.id)).toEqual([2, 3]);
    expect(top[0]?.rrf_score).toBe(0.05);
  });

  test('fuse sums contributions for id in both lists', () => {
    const fusion = new RrfFusion(60, {
      keywordWeight: 1,
      semanticWeight: 1,
    });
    const scores = fusion.fuse([5], [5]);
    // rank 1 in each: 1/61 + 1/61
    expect(scores.get(5)).toBeCloseTo(2 / 61, 10);
  });
});
