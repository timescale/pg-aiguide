import { describe, expect, test } from 'bun:test';
import {
  chunkIdOf,
  expectDocId,
  parseDocId,
  parseSearchSource,
  sectionIdOf,
  sourceOfUrl,
} from './docSources.js';

describe('doc ids', () => {
  test('round-trip', () => {
    expect(parseDocId(chunkIdOf('tiger', 4483))).toEqual({
      kind: 'chunk',
      source: 'tiger',
      chunkId: 4483,
    });
    expect(parseDocId(sectionIdOf('postgres', 12, 3))).toEqual({
      kind: 'section',
      source: 'postgres',
      pageId: 12,
      sectionIndex: 3,
    });
    expect(parseDocId('postgis:page:5')).toEqual({
      kind: 'page',
      source: 'postgis',
      pageId: 5,
    });
  });

  test('rejects malformed ids', () => {
    expect(() => parseDocId('4483')).toThrow('not a docs id');
    expect(() => parseDocId('mysql:chunk:1')).toThrow('not a docs id');
    expect(() => parseDocId('tiger:section:12')).toThrow('not a well-formed');
  });

  test('expectDocId names the wrong kind', () => {
    expect(() => expectDocId('tiger:page:1', ['chunk'])).toThrow(
      'is a page id; this tool takes a chunk id',
    );
  });
});

describe('parseSearchSource', () => {
  test('splits version', () => {
    expect(parseSearchSource('postgis_3.5')).toEqual({
      source: 'postgis',
      version: '3.5',
    });
    expect(parseSearchSource('tiger')).toEqual({
      source: 'tiger',
      version: null,
    });
  });

  test('rejects unknown sources', () => {
    expect(() => parseSearchSource('_postgres')).toThrow('Invalid source');
  });
});

describe('sourceOfUrl', () => {
  test('maps hosts to sources', () => {
    expect(sourceOfUrl('https://www.tigerdata.com/docs/a#b')).toBe('tiger');
    expect(sourceOfUrl('https://enterprise.tigerdata.com/docs/a')).toBeNull();
    expect(sourceOfUrl('https://www.postgresql.org/docs/17/a.html')).toBe(
      'postgres',
    );
    expect(sourceOfUrl('https://postgis.net/docs/a.html')).toBe('postgis');
    expect(sourceOfUrl('https://example.com')).toBeNull();
    expect(sourceOfUrl('not a url')).toBeNull();
  });
});
