/**
 * Rebuilds pages and sections from stored chunks, so a search hit can be read
 * in the context it came from.
 *
 * Two chunkers write these tables, and the text has to be put back together
 * differently for each:
 *
 * - Tiger docs (`chunking_method: "header_based"`): split on H1–H3, then each
 *   section is cut into ~2000-character sub-chunks that OVERLAP by up to 200
 *   characters, and every chunk is prefixed with the breadcrumb of its parent
 *   headings. Metadata carries `Header 1` … `Header 3`.
 * - Postgres and PostGIS (`chunk_markdown_lines`): split on every
 *   heading, the heading line itself is not stored, and large sections are cut
 *   on token boundaries with no overlap. Metadata carries `header_path`.
 *
 * Everything here works on rows already loaded, so it is unit tested without
 * a database; `loadPage` is the only function that queries.
 */

import type { Pool } from 'pg';
import {
  chunkIdOf,
  type DocSource,
  entityPrefixOf,
  pageIdOf,
  sectionIdOf,
} from './docSources.js';

/** Overlap between Tiger sub-chunks is at most `chunk_overlap` (200) chars. */
const MAX_SUB_CHUNK_OVERLAP = 400;
/** Shorter matches are as likely to be coincidence as real overlap. */
const MIN_SUB_CHUNK_OVERLAP = 12;

export type Heading = { level: number; text: string };

export type ChunkRow = {
  id: number;
  page_id: number;
  chunk_index: number;
  sub_chunk_index: number;
  content: string;
  metadata: string | Record<string, unknown> | null;
};

export type PageRow = {
  id: number;
  url: string;
  filename: string | null;
  version: string | null;
};

export type DocChunk = {
  id: number;
  chunkId: string;
  sectionIndex: number;
  subIndex: number;
  /** Stored text, unchanged. */
  content: string;
  /** Stored text with the breadcrumb prefix removed. */
  body: string;
};

export type DocSection = {
  index: number;
  sectionId: string;
  headings: Heading[];
  url: string | null;
  chunks: DocChunk[];
  /** The section's own text: its heading line and body, no parent headings. */
  body: string;
  overlapTrimmed: boolean;
};

export type DocPage = {
  source: DocSource;
  id: number;
  pageId: string;
  url: string;
  version: string | null;
  title: string;
  sections: DocSection[];
};

export const parseMetadata = (
  metadata: ChunkRow['metadata'],
): Record<string, unknown> => {
  if (!metadata) return {};
  if (typeof metadata !== 'string') return metadata;
  try {
    const parsed: unknown = JSON.parse(metadata);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

/** `[Title](#anchor)` → `Title`, and a trailing ` (#anchor)` is dropped. */
const cleanHeadingText = (text: string): string =>
  text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s*\(#[^)]*\)\s*$/, '')
    .trim();

/** The heading path of a chunk, outermost first, from either metadata shape. */
export const headingsOf = (metadata: Record<string, unknown>): Heading[] => {
  const tiger: Heading[] = [];
  for (const level of [1, 2, 3]) {
    const text = metadata[`Header ${level}`];
    if (typeof text === 'string' && text.trim())
      tiger.push({ level, text: text.trim() });
  }
  if (tiger.length) return tiger;

  const path = metadata.header_path;
  if (Array.isArray(path)) {
    return path
      .filter((h): h is string => typeof h === 'string' && h.trim() !== '')
      .map((text, i) => ({ level: i + 1, text: cleanHeadingText(text) }));
  }
  const header = metadata.header;
  if (typeof header === 'string' && header.trim())
    return [{ level: 1, text: cleanHeadingText(header) }];
  return [];
};

export const headingLine = ({ level, text }: Heading): string =>
  `${'#'.repeat(Math.min(Math.max(level, 1), 6))} ${text}`;

/**
 * The breadcrumb Tiger ingest prepends to every chunk: every heading but the
 * deepest, one per line, then a blank line (`add_header_breadcrumbs_to_content`).
 */
export const breadcrumbOf = (headings: Heading[]): string =>
  headings.length > 1
    ? `${headings.slice(0, -1).map(headingLine).join('\n')}\n\n`
    : '';

export const stripBreadcrumb = (
  content: string,
  headings: Heading[],
): string => {
  const crumb = breadcrumbOf(headings);
  return crumb && content.startsWith(crumb)
    ? content.slice(crumb.length)
    : content;
};

/**
 * Length of the longest suffix of `prev` that is also a prefix of `next`,
 * within the overlap a splitter could have produced, or 0.
 */
export const overlapLength = (prev: string, next: string): number => {
  const max = Math.min(MAX_SUB_CHUNK_OVERLAP, prev.length, next.length);
  for (let k = max; k >= MIN_SUB_CHUNK_OVERLAP; k--) {
    if (prev.endsWith(next.slice(0, k))) return k;
  }
  return 0;
};

/**
 * Joins a section's sub-chunk bodies into one text. Overlapping chunks
 * (Tiger) are joined at the overlap; token-split chunks are concatenated.
 */
export const joinSubChunks = (
  bodies: string[],
  overlapping: boolean,
): { text: string; overlapTrimmed: boolean } => {
  if (!overlapping) return { text: bodies.join(''), overlapTrimmed: false };
  let text = bodies[0] ?? '';
  let overlapTrimmed = false;
  for (const body of bodies.slice(1)) {
    const k = overlapLength(text, body);
    if (k > 0) {
      overlapTrimmed = true;
      text += body.slice(k);
    } else {
      // The splitter strips whitespace at cuts; a newline is the usual one.
      text += `\n${body}`;
    }
  }
  return { text, overlapTrimmed };
};

/** True when `body` already opens with the section's own heading line. */
const opensWithHeading = (body: string, heading: Heading | undefined) => {
  if (!heading) return true;
  const firstLine = body.trimStart().split('\n', 1)[0] ?? '';
  const match = /^#{1,6}\s+(.+?)\s*$/.exec(firstLine);
  return (
    match?.[1] !== undefined &&
    cleanHeadingText(match[1]) === cleanHeadingText(heading.text)
  );
};

/**
 * Groups a page's chunk rows (any order) into sections and stitches each
 * section's text.
 */
export const assemblePage = (
  source: DocSource,
  page: PageRow,
  rows: ChunkRow[],
): DocPage => {
  const sorted = [...rows].sort(
    (a, b) =>
      a.chunk_index - b.chunk_index || a.sub_chunk_index - b.sub_chunk_index,
  );

  const sections: DocSection[] = [];
  for (const row of sorted) {
    const metadata = parseMetadata(row.metadata);
    let section = sections.at(-1);
    if (!section || section.index !== row.chunk_index) {
      const sourceUrl = metadata.source_url;
      section = {
        index: row.chunk_index,
        sectionId: sectionIdOf(source, page.id, row.chunk_index),
        headings: headingsOf(metadata),
        url: typeof sourceUrl === 'string' ? sourceUrl : null,
        chunks: [],
        body: '',
        overlapTrimmed: false,
      };
      sections.push(section);
    }
    section.chunks.push({
      id: row.id,
      chunkId: chunkIdOf(source, row.id),
      sectionIndex: row.chunk_index,
      subIndex: row.sub_chunk_index,
      content: row.content,
      body: stripBreadcrumb(row.content, section.headings),
    });
  }

  for (const section of sections) {
    const overlapping = section.chunks.length > 1 && source === 'tiger';
    const { text, overlapTrimmed } = joinSubChunks(
      section.chunks.map((c) => c.body),
      overlapping,
    );
    const own = section.headings.at(-1);
    section.body =
      own && !opensWithHeading(text, own)
        ? `${headingLine(own)}\n\n${text.trimStart()}`
        : text;
    section.overlapTrimmed = overlapTrimmed;
  }

  const title =
    sections.find((s) => s.headings.length)?.headings[0]?.text ??
    page.filename ??
    page.url;

  return {
    source,
    id: page.id,
    pageId: pageIdOf(source, page.id),
    url: page.url,
    version: page.version,
    title,
    sections,
  };
};

/** A section's text with its parent headings, so it reads on its own. */
export const renderSection = (section: DocSection): string =>
  `${breadcrumbOf(section.headings)}${section.body}`.trim();

/**
 * Renders consecutive sections as one markdown text, printing each parent
 * heading once (where the path changes) rather than before every section.
 */
export const renderSections = (sections: DocSection[]): string => {
  const parts: string[] = [];
  let printed: Heading[] = [];
  for (const section of sections) {
    const parents = section.headings.slice(0, -1);
    const lines: string[] = [];
    parents.forEach((h, i) => {
      if (printed[i]?.text !== h.text || printed[i]?.level !== h.level) {
        lines.push(headingLine(h));
        printed = printed.slice(0, i);
      }
      printed[i] = h;
    });
    printed = [...parents, ...section.headings.slice(-1)];
    if (lines.length) parts.push(lines.join('\n\n'));
    parts.push(section.body.trim());
  }
  return parts.filter(Boolean).join('\n\n');
};

/**
 * The sections nested under `section`: those that follow it and whose
 * heading path extends its path, up to the next sibling or ancestor.
 */
export const subsectionsOf = (
  page: DocPage,
  section: DocSection,
): DocSection[] => {
  const start = page.sections.indexOf(section);
  const depth = section.headings.length;
  const out: DocSection[] = [];
  for (const next of page.sections.slice(start + 1)) {
    const nested =
      next.headings.length > depth &&
      section.headings.every((h, i) => next.headings[i]?.text === h.text);
    if (!nested) break;
    out.push(next);
  }
  return out;
};

export const headingTexts = (headings: Heading[]): string[] =>
  headings.map((h) => h.text);

export type LoadPageContext = {
  pgPool: Pool;
  schema: string;
  source: DocSource;
};

/** Loads one page and all its chunks; throws if the page does not exist. */
export async function loadPage(
  { pgPool, schema, source }: LoadPageContext,
  pageId: number,
): Promise<DocPage> {
  const prefix = entityPrefixOf(source);
  const [pageResult, chunkResult] = await Promise.all([
    pgPool.query<PageRow>(
      /* sql */ `
        SELECT p.id::int, p.url, p.filename, to_jsonb(p)->>'version' AS version
        FROM ${schema}.${prefix}_pages p
        WHERE p.id = $1
      `,
      [pageId],
    ),
    pgPool.query<ChunkRow>(
      /* sql */ `
        SELECT c.id::int, c.page_id::int, c.chunk_index::int,
               c.sub_chunk_index::int, c.content, c.metadata::text
        FROM ${schema}.${prefix}_chunks c
        WHERE c.page_id = $1
        ORDER BY c.chunk_index, c.sub_chunk_index
      `,
      [pageId],
    ),
  ]);
  const page = pageResult.rows[0];
  if (!page) throw new Error(`No ${source} page with id ${pageId}.`);
  return assemblePage(source, page, chunkResult.rows);
}

/** The page a chunk belongs to, or throws if the chunk does not exist. */
export async function pageIdOfChunk(
  { pgPool, schema, source }: LoadPageContext,
  chunkId: number,
): Promise<number> {
  const { rows } = await pgPool.query<{ page_id: number }>(
    /* sql */ `
      SELECT c.page_id::int
      FROM ${schema}.${entityPrefixOf(source)}_chunks c
      WHERE c.id = $1
    `,
    [chunkId],
  );
  const row = rows[0];
  if (!row) throw new Error(`No ${source} chunk with id ${chunkId}.`);
  return row.page_id;
}

/** Finds a page by URL, ignoring any #fragment and a trailing slash. */
export async function pageIdOfUrl(
  { pgPool, schema, source }: LoadPageContext,
  url: string,
): Promise<number> {
  const bare = url.split('#', 1)[0]?.replace(/\/+$/, '') ?? url;
  const { rows } = await pgPool.query<{ id: number }>(
    /* sql */ `
      SELECT p.id::int
      FROM ${schema}.${entityPrefixOf(source)}_pages p
      WHERE p.url IN ($1, $1 || '/')
      ORDER BY p.id
      LIMIT 1
    `,
    [bare],
  );
  const row = rows[0];
  if (!row) throw new Error(`No ${source} page with URL ${bare}.`);
  return row.id;
}
