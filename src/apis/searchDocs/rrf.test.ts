import { describe, expect, it } from 'bun:test';
import { mergeRrf } from './rrf.js';

function chunk(id: number, content = `c${id}`, metadata = '{}') {
  return { id, content, metadata };
}

describe('mergeRrf', () => {
  it('returns empty when both lists are empty', () => {
    expect(mergeRrf([], [], 10)).toEqual([]);
  });

  it('returns empty when resultLimit is 0', () => {
    expect(mergeRrf([chunk(1)], [chunk(1)], 0)).toEqual([]);
  });

  it('respects resultLimit', () => {
    const semantic = [chunk(1), chunk(2), chunk(3)];
    const keyword = [chunk(1)];
    expect(mergeRrf(semantic, keyword, 2)).toHaveLength(2);
  });

  it('prefers an id that ranks well in both lists', () => {
    const semantic = [chunk(1), chunk(2), chunk(3)];
    const keyword = [chunk(2)];
    const r = mergeRrf(semantic, keyword, 10);
    expect(r[0]?.id).toBe(2);
  });

  it('keeps content and metadata from the semantic list when id appears there first', () => {
    const semantic = [chunk(1, 'from-sem', '{"a":1}')];
    const keyword = [chunk(1, 'from-kw', '{"b":2}')];
    const r = mergeRrf(semantic, keyword, 1);
    expect(r[0]).toMatchObject({
      id: 1,
      content: 'from-sem',
      metadata: '{"a":1}',
    });
    expect(r[0]?.rrf_score).toBeCloseTo(1 / 61 + 1 / 61, 10);
  });

  it('takes content from keyword when id is only in the keyword list', () => {
    const semantic = [chunk(1)];
    const keyword = [chunk(2, 'only-kw', '{}')];
    const r = mergeRrf(semantic, keyword, 10);
    const row2 = r.find((x) => x.id === 2);
    expect(row2?.content).toBe('only-kw');
  });
});
