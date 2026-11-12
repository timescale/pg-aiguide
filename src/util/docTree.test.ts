import { describe, expect, test } from 'bun:test';
import { assemblePage, type ChunkRow } from './docPages.js';
import {
  childrenOf,
  type DocNode,
  nodeIdOf,
  parentOf,
  sectionNode,
  sectionOfFragment,
  sharedHeadingDepth,
  siblingsOf,
  textOf,
} from './docTree.js';

const page = { id: 7, url: 'https://x/docs/p', filename: 'p', version: null };

const row = (
  chunkIndex: number,
  headers: Record<string, string>,
  content: string,
  anchor: string,
): ChunkRow => ({
  id: 100 + chunkIndex,
  page_id: 7,
  chunk_index: chunkIndex,
  sub_chunk_index: 0,
  content,
  metadata: { ...headers, source_url: `https://x/docs/p#${anchor}` },
});

// # Billing > ## Features > ### Notes, then ## Support.
const doc = assemblePage('tiger', page, [
  row(0, { 'Header 1': 'Billing' }, '# Billing\n\nIntro.', 'billing'),
  row(
    1,
    { 'Header 1': 'Billing', 'Header 2': 'Features' },
    '# Billing\n\n## Features\n\n| a | b |',
    'features',
  ),
  row(
    2,
    { 'Header 1': 'Billing', 'Header 2': 'Features', 'Header 3': 'Notes' },
    '# Billing\n## Features\n\n### Notes\n\nSome notes.',
    'notes',
  ),
  row(
    3,
    { 'Header 1': 'Billing', 'Header 2': 'Support' },
    '# Billing\n\n## Support\n\nEmail us.',
    'support',
  ),
]);
const [billing, features, notes, support] = doc.sections;
if (!billing || !features || !notes || !support) throw new Error('fixture');
const ids = (sections: { sectionId: string }[]) =>
  sections.map((s) => s.sectionId);
const pageNode: DocNode = { kind: 'page', page: doc };

describe('docTree', () => {
  test("folds a page's single H1 into the page", () => {
    expect(nodeIdOf(sectionNode(doc, billing))).toBe('tiger:page:7');
    expect(ids(childrenOf(pageNode))).toEqual([
      'tiger:section:7.1',
      'tiger:section:7.3',
    ]);
  });

  test('walks up one level at a time, to the page', () => {
    const notesNode = sectionNode(doc, notes);
    const up = parentOf(notesNode);
    expect(up && nodeIdOf(up)).toBe('tiger:section:7.1');
    const top = up && parentOf(up);
    expect(top && nodeIdOf(top)).toBe('tiger:page:7');
    expect(top && parentOf(top)).toBeNull();
  });

  test('lists children and siblings one level away', () => {
    const featuresNode = sectionNode(doc, features);
    expect(ids(childrenOf(featuresNode))).toEqual(['tiger:section:7.2']);
    const { previous, next } = siblingsOf(featuresNode);
    expect(previous).toBeNull();
    expect(next?.sectionId).toBe('tiger:section:7.3');
    expect(siblingsOf(sectionNode(doc, notes))).toEqual({
      previous: null,
      next: null,
    });
  });

  test("a section's text covers everything nested under it", () => {
    expect(textOf(sectionNode(doc, features))).toBe(
      '# Billing\n\n## Features\n\n| a | b |\n\n### Notes\n\nSome notes.',
    );
    expect(textOf(pageNode)).toContain('Email us.');
  });

  test('finds a section by URL fragment', () => {
    expect(sectionOfFragment(doc, 'https://x/docs/p#Features')?.sectionId).toBe(
      'tiger:section:7.1',
    );
    expect(sectionOfFragment(doc, 'https://x/docs/p')).toBeNull();
    expect(sectionOfFragment(doc, 'https://x/docs/p#nope')).toBeNull();
  });

  test('a page without a single root lists its top sections', () => {
    const flat = assemblePage('postgres', { ...page, version: '17' }, [
      {
        id: 1,
        page_id: 7,
        chunk_index: 0,
        sub_chunk_index: 0,
        content: 'First chapter.',
        metadata: { header_path: ['One'] },
      },
      {
        id: 2,
        page_id: 7,
        chunk_index: 1,
        sub_chunk_index: 0,
        content: 'Second chapter.',
        metadata: { header_path: ['Two'] },
      },
    ]);
    const node: DocNode = { kind: 'page', page: flat };
    expect(ids(childrenOf(node))).toEqual([
      'postgres:section:7.0',
      'postgres:section:7.1',
    ]);
    const second = flat.sections[1];
    if (!second) throw new Error('fixture');
    expect(siblingsOf(sectionNode(flat, second)).previous?.sectionId).toBe(
      'postgres:section:7.0',
    );
  });

  test('counts the headings every section shares', () => {
    expect(sharedHeadingDepth(doc.sections)).toBe(1);
    expect(sharedHeadingDepth([features, notes])).toBe(2);
    expect(sharedHeadingDepth([])).toBe(0);
  });
});
