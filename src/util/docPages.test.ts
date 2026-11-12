import { describe, expect, test } from 'bun:test';
import {
  assemblePage,
  type ChunkRow,
  headingsOf,
  joinSubChunks,
  overlapLength,
  partContaining,
  renderSections,
  splitIntoParts,
  stripBreadcrumb,
  subsectionsOf,
} from './docPages.js';

const page = { id: 7, url: 'https://x/docs/p', filename: 'p', version: null };

const tigerRow = (
  id: number,
  chunkIndex: number,
  sub: number,
  headers: Record<string, string>,
  content: string,
): ChunkRow => ({
  id,
  page_id: 7,
  chunk_index: chunkIndex,
  sub_chunk_index: sub,
  content,
  metadata: JSON.stringify({
    ...headers,
    source_url: `https://x/docs/p#s${chunkIndex}`,
    chunk_index: chunkIndex,
    sub_chunk_index: sub,
    chunking_method: 'header_based',
  }),
});

describe('headingsOf', () => {
  test('reads Tiger Header 1..3', () => {
    expect(headingsOf({ 'Header 1': 'Billing', 'Header 3': 'Limits' })).toEqual(
      [
        { level: 1, text: 'Billing' },
        { level: 3, text: 'Limits' },
      ],
    );
  });

  test('reads header_path and strips link syntax', () => {
    expect(
      headingsOf({ header_path: ['CREATE INDEX', '[Notes](#notes)'] }),
    ).toEqual([
      { level: 1, text: 'CREATE INDEX' },
      { level: 2, text: 'Notes' },
    ]);
  });
});

describe('stripBreadcrumb', () => {
  const headings = [
    { level: 1, text: 'Billing' },
    { level: 2, text: 'Features' },
  ];

  test('removes the parent-heading prefix Tiger ingest adds', () => {
    expect(stripBreadcrumb('# Billing\n\n| a | b |', headings)).toBe(
      '| a | b |',
    );
  });

  test('leaves text without the prefix alone', () => {
    expect(stripBreadcrumb('| a | b |', headings)).toBe('| a | b |');
  });
});

describe('joinSubChunks', () => {
  test('joins overlapping chunks at the overlap', () => {
    const a = 'row one | x |\nrow two | y |\nrow three | z |';
    const b = 'row two | y |\nrow three | z |\nrow four | w |';
    expect(overlapLength(a, b)).toBe('row two | y |\nrow three | z |'.length);
    expect(joinSubChunks([a, b], true)).toEqual({
      text: 'row one | x |\nrow two | y |\nrow three | z |\nrow four | w |',
      overlapTrimmed: true,
    });
  });

  test('falls back to a newline when there is no overlap', () => {
    expect(joinSubChunks(['first part', 'second part'], true).text).toBe(
      'first part\nsecond part',
    );
  });

  test('ignores coincidental short matches', () => {
    expect(overlapLength('ends with a', 'a starts')).toBe(0);
  });

  test('concatenates token-split chunks', () => {
    expect(joinSubChunks(['abc', 'def'], false).text).toBe('abcdef');
  });
});

describe('assemblePage', () => {
  const rows = [
    // Out of order on purpose.
    tigerRow(
      12,
      1,
      1,
      { 'Header 1': 'Billing', 'Header 2': 'Features' },
      '# Billing\n\n| IP allow list | 1 list | Unlimited lists |\n| MFA | ✓ | ✓ |',
    ),
    tigerRow(10, 0, 0, { 'Header 1': 'Billing' }, '# Billing\n\nIntro text.'),
    tigerRow(
      11,
      1,
      0,
      { 'Header 1': 'Billing', 'Header 2': 'Features' },
      '# Billing\n\n## Features\n\n| Feature | Performance | Scale |\n|---|---|---|\n| IP allow list | 1 list | Unlimited lists |',
    ),
    tigerRow(
      13,
      2,
      0,
      { 'Header 1': 'Billing', 'Header 2': 'Features', 'Header 3': 'Notes' },
      '# Billing\n## Features\n\n### Notes\n\nSome notes.',
    ),
    tigerRow(
      14,
      3,
      0,
      { 'Header 1': 'Billing', 'Header 2': 'Support' },
      '# Billing\n\n## Support\n\nEmail us.',
    ),
  ];
  const doc = assemblePage('tiger', page, rows);

  test('groups chunks into sections in order', () => {
    expect(doc.pageId).toBe('tiger:page:7');
    expect(doc.title).toBe('Billing');
    expect(doc.sections.map((s) => s.sectionId)).toEqual([
      'tiger:section:7.0',
      'tiger:section:7.1',
      'tiger:section:7.2',
      'tiger:section:7.3',
    ]);
    expect(doc.sections[1]?.chunks.map((c) => c.chunkId)).toEqual([
      'tiger:chunk:11',
      'tiger:chunk:12',
    ]);
  });

  test('stitches a split table back under its header row, once', () => {
    const body = doc.sections[1]?.body ?? '';
    expect(body).toBe(
      '## Features\n\n| Feature | Performance | Scale |\n|---|---|---|\n| IP allow list | 1 list | Unlimited lists |\n| MFA | ✓ | ✓ |',
    );
    expect(doc.sections[1]?.overlapTrimmed).toBe(true);
  });

  test('finds nested subsections up to the next sibling', () => {
    const features = doc.sections[1];
    if (!features) throw new Error('missing section');
    expect(subsectionsOf(doc, features).map((s) => s.sectionId)).toEqual([
      'tiger:section:7.2',
    ]);
  });

  test('renders parent headings once across sections', () => {
    expect(renderSections(doc.sections.slice(1, 3))).toBe(
      '# Billing\n\n## Features\n\n| Feature | Performance | Scale |\n|---|---|---|\n| IP allow list | 1 list | Unlimited lists |\n| MFA | ✓ | ✓ |\n\n### Notes\n\nSome notes.',
    );
  });
});

describe('assemblePage — header_path sources', () => {
  test('adds the heading line the importer does not store', () => {
    const doc = assemblePage('postgres', { ...page, version: '17' }, [
      {
        id: 1,
        page_id: 7,
        chunk_index: 0,
        sub_chunk_index: 0,
        content: 'CREATE INDEX constructs an index',
        metadata: { header_path: ['CREATE INDEX'] },
      },
      {
        id: 2,
        page_id: 7,
        chunk_index: 0,
        sub_chunk_index: 1,
        content: ' on the specified column(s).',
        metadata: { header_path: ['CREATE INDEX'] },
      },
    ]);
    expect(doc.version).toBe('17');
    expect(doc.sections[0]?.body).toBe(
      '# CREATE INDEX\n\nCREATE INDEX constructs an index on the specified column(s).',
    );
  });
});

describe('splitIntoParts', () => {
  test('returns the text whole when it fits', () => {
    expect(splitIntoParts('short', 100)).toEqual(['short']);
    expect(splitIntoParts('', 100)).toEqual(['']);
  });

  test('cuts at paragraph breaks, under the limit', () => {
    const paras = Array.from(
      { length: 10 },
      (_, i) => `para ${i} ${'x'.repeat(30)}`,
    );
    const parts = splitIntoParts(paras.join('\n\n'), 100);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(100);
    expect(parts.join('\n\n')).toBe(paras.join('\n\n'));
  });

  test('cuts hard when there is no break', () => {
    expect(splitIntoParts('a'.repeat(250), 100).map((p) => p.length)).toEqual([
      100, 100, 50,
    ]);
  });
});

describe('partContaining', () => {
  const parts = ['first part about tables', 'second part about indexes'];

  test('finds the part holding a chunk body', () => {
    expect(partContaining(parts, 'part about indexes')).toBe(1);
  });

  test('falls back to the first part', () => {
    expect(partContaining(parts, 'not there')).toBe(0);
  });
});
