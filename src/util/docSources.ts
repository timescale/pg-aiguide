/**
 * Documentation sources and the opaque ids the navigation tools hand out.
 *
 * A search hit, a section and a page each get a string id that names its
 * source, so a follow-up call (get_section, get_page)
 * needs only the id and never a separate `source` argument:
 *
 *   tiger:chunk:4483        one stored chunk
 *   tiger:section:212.9     section 9 (chunk_index) of page 212
 *   tiger:page:212          a whole page
 *
 * Chunk and page ids are unique per table, not per version, so versioned
 * sources (postgres_17, postgis_3.5) use their base source in ids.
 */

export const DOC_SOURCES = ['tiger', 'postgres', 'postgis'] as const;

export type DocSource = (typeof DOC_SOURCES)[number];

const ENTITY_PREFIXES: Record<DocSource, string> = {
  tiger: 'timescale',
  postgres: 'postgres',
  postgis: 'postgis',
};

export const isDocSource = (value: string): value is DocSource =>
  (DOC_SOURCES as readonly string[]).includes(value);

/** Table name prefix for a source: `${schema}.${prefix}_chunks` / `_pages`. */
export const entityPrefixOf = (source: DocSource): string =>
  ENTITY_PREFIXES[source];

/** Splits a search `source` value such as "postgres_17" into source and version. */
export const parseSearchSource = (
  passed: string,
): { source: DocSource; version: string | null } => {
  const [source, version = null] = passed.split('_');
  if (!source || !isDocSource(source)) throw new Error('Invalid source');
  return { source, version };
};

export type ChunkRef = { source: DocSource; chunkId: number };
export type PageRef = { source: DocSource; pageId: number };
export type SectionRef = PageRef & { sectionIndex: number };

export const chunkIdOf = (source: DocSource, chunkId: number): string =>
  `${source}:chunk:${chunkId}`;

export const pageIdOf = (source: DocSource, pageId: number): string =>
  `${source}:page:${pageId}`;

export const sectionIdOf = (
  source: DocSource,
  pageId: number,
  sectionIndex: number,
): string => `${source}:section:${pageId}.${sectionIndex}`;

const ID_PATTERN = /^([a-z]+):(chunk|page|section):(\d+)(?:\.(\d+))?$/;

type ParsedId =
  | ({ kind: 'chunk' } & ChunkRef)
  | ({ kind: 'page' } & PageRef)
  | ({ kind: 'section' } & SectionRef);

export const parseDocId = (id: string): ParsedId => {
  const match = ID_PATTERN.exec(id.trim());
  const [, source, kind, first, second] = match ?? [];
  if (!source || !kind || !first || !isDocSource(source)) {
    throw new Error(
      `"${id}" is not a docs id. Use a chunk_id, section_id or page_id exactly as search_docs or another docs tool returned it.`,
    );
  }
  const n = Number(first);
  if (kind === 'chunk' && second === undefined)
    return { kind, source, chunkId: n };
  if (kind === 'page' && second === undefined)
    return { kind, source, pageId: n };
  if (kind === 'section' && second !== undefined)
    return { kind, source, pageId: n, sectionIndex: Number(second) };
  throw new Error(`"${id}" is not a well-formed ${kind} id.`);
};

/** Expects one id kind and returns its parsed form, or throws a clear error. */
export const expectDocId = <K extends ParsedId['kind']>(
  id: string,
  kinds: readonly K[],
): Extract<ParsedId, { kind: K }> => {
  const parsed = parseDocId(id);
  if (!(kinds as readonly string[]).includes(parsed.kind)) {
    throw new Error(
      `"${id}" is a ${parsed.kind} id; this tool takes a ${kinds.join(' or ')} id.`,
    );
  }
  return parsed as Extract<ParsedId, { kind: K }>;
};

/**
 * Which source a docs URL belongs to, by host. Used by get_page when it is
 * given a URL instead of a page id.
 */
export const sourceOfUrl = (url: string): DocSource | null => {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  // Enterprise docs are not ingested here.
  if (host === 'enterprise.tigerdata.com') return null;
  if (host.endsWith('tigerdata.com') || host.endsWith('timescale.com'))
    return 'tiger';
  if (host.endsWith('postgresql.org')) return 'postgres';
  if (host.endsWith('postgis.net')) return 'postgis';
  return null;
};
