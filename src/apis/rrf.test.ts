import { describe, expect, test } from 'bun:test';
import { DEFAULT_RRF_K, rrfRankedTop } from './rrf.js';

describe('RRF', () => {
  test('DEFAULT_RRF_K is 60', () => {
    expect(DEFAULT_RRF_K).toBe(60);
  });

  test('rrfRankedTop prefers id that appears high in both lists', () => {
    const top = rrfRankedTop([1], [2, 1], 60, 1, 1, 10);
    expect(top.map((t) => t.id)).toEqual([1, 2]);
  });

  test('zero keyword weight ignores keyword ordering', () => {
    const top = rrfRankedTop([9, 8], [8, 9], 60, 1, 0, 2);
    expect(top.map((t) => t.id)).toEqual([9, 8]);
  });

  test('zero semantic weight ignores semantic ordering', () => {
    const top = rrfRankedTop([9, 8], [8, 9], 60, 0, 1, 2);
    expect(top.map((t) => t.id)).toEqual([8, 9]);
  });

  test('rrfRankedTop orders by fused score descending', () => {
    const top = rrfRankedTop([1, 2, 3], [], 60, 1, 0, 3);
    expect(top.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(top[0]?.rrf_score).toBeGreaterThan(top[1]?.rrf_score ?? 0);
    expect(top[1]?.rrf_score).toBeGreaterThan(top[2]?.rrf_score ?? 0);
  });

  test('rrfRankedTop exposes fused score for id in both lists', () => {
    const top = rrfRankedTop([5], [5], 60, 1, 1, 10);
    const row = top.find((t) => t.id === 5);
    expect(row?.rrf_score).toBeCloseTo(2 / 61, 10);
  });
});
