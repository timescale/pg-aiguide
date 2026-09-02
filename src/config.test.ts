import { describe, expect, test } from 'bun:test';

import { DEFAULT_DB_SCHEMA, parseDbSchema } from './config.js';

describe('parseDbSchema', () => {
  test('defaults when unset', () => {
    expect(parseDbSchema(undefined)).toBe(DEFAULT_DB_SCHEMA);
  });

  test('defaults when empty or whitespace', () => {
    expect(parseDbSchema('')).toBe(DEFAULT_DB_SCHEMA);
    expect(parseDbSchema('   ')).toBe(DEFAULT_DB_SCHEMA);
  });

  test('trims surrounding whitespace', () => {
    expect(parseDbSchema('  docs  ')).toBe('docs');
  });

  test.each(['docs', '_docs', 'docs_v2', 'docs$1', 'a', 'a'.repeat(63)])(
    'accepts %p',
    (value) => {
      expect(parseDbSchema(value)).toBe(value);
    },
  );

  test.each([
    ['uppercase', 'Docs'],
    ['leading digit', '1docs'],
    ['dot', 'my.docs'],
    ['space', 'my docs'],
    ['hyphen', 'my-docs'],
    ['double quote', 'do"cs'],
    ['single quote', "do'cs"],
    ['semicolon injection', 'public" CASCADE; DROP TABLE migrations; --'],
    ['bm25 literal injection', "docs'); DROP TABLE migrations; --"],
    ['search_path injection', 'docs,public --search_path=evil'],
    ['too long', 'a'.repeat(64)],
  ])('rejects %s', (_label, value) => {
    expect(() => parseDbSchema(value)).toThrow(/Invalid DB_SCHEMA/);
  });
});
