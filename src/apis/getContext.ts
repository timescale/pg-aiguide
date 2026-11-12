import type { ApiFactory, InferSchema } from '@tigerdata/mcp-boilerplate';
import { z } from 'zod';
import type { ServerContext } from '../types.js';
import {
  type DocPage,
  headingLine,
  headingTexts,
  loadPage,
  pageIdOfChunk,
  pageIdOfUrl,
  partContaining,
  splitIntoParts,
} from '../util/docPages.js';
import { expectDocId, sourceOfUrl } from '../util/docSources.js';
import {
  childrenOf,
  type DocNode,
  nodeIdOf,
  parentOf,
  sectionNode,
  sectionOfFragment,
  sharedHeadingDepth,
  siblingsOf,
  subtreeOf,
  textOf,
} from '../util/docTree.js';

/** Text longer than this (about 5,000 tokens) is returned a part at a time. */
export const DOC_PART_MAX_CHARS = 20_000;

const inputSchema = {
  id: z
    .string()
    .nullable()
    .describe(
      'Any docs id: a chunk_id or section_id from search_docs, a page_id, or a parent_id / children id from an earlier get_context. A chunk_id returns the section the chunk is in. Give this or url.',
    ),
  url: z
    .string()
    .nullable()
    .describe(
      'A docs URL (tigerdata.com/docs, postgresql.org/docs, postgis.net/docs), e.g. a link found in docs text. With a #fragment it returns that section, otherwise the page. Give this or id.',
    ),
  part: z
    .number()
    .int()
    .min(1)
    .nullable()
    .describe(
      'Which part of the text to return when part_count > 1. Defaults to the part holding the chunk you passed, else part 1.',
    ),
} as const;

const zChild = z.object({
  id: z.string(),
  heading: z
    .string()
    .describe(
      'Its heading path below this node, e.g. "4.1. Spatial Data Model > 4.1.1. OGC Geometry" when the level between has no text of its own.',
    ),
  characters: z
    .number()
    .int()
    .describe('Length of its text, including its own children.'),
});

const outputSchema = {
  id: z.string().describe('This node: a section_id, or the page_id.'),
  kind: z.enum(['page', 'section']),
  title: z.string().describe('Page title.'),
  page_id: z.string(),
  page_url: z.string(),
  version: z
    .string()
    .nullable()
    .describe('Docs version, for versioned sources (Postgres, PostGIS).'),
  headings: z
    .array(z.string())
    .describe('Heading path of this node, outermost first. Empty for a page.'),
  url: z.string().nullable().describe('Link to this node on the docs site.'),
  text: z
    .string()
    .describe(
      'The node as markdown with everything nested under it, led by its parent headings. When part_count > 1 this is one part.',
    ),
  part: z.number().int().describe('Which part `text` is, from 1.'),
  part_count: z
    .number()
    .int()
    .describe('Above 1, call again with `part` for the rest.'),
  parent_id: z
    .string()
    .nullable()
    .describe(
      'The node one level up (the enclosing section, or the page). Null for a page.',
    ),
  children: z
    .array(zChild)
    .describe(
      'The sections one level down, in order. Their text is already in `text`; open one by id to read just that part.',
    ),
  previous_id: z
    .string()
    .nullable()
    .describe('The previous section at the same level, under the same parent.'),
  next_id: z
    .string()
    .nullable()
    .describe('The next section at the same level, under the same parent.'),
} as const;

/** Resolves the input to a node, and the chunk it was asked for, if any. */
async function resolveNode(
  { pgPool, schema }: ServerContext,
  id: string | null,
  url: string | null,
): Promise<{ node: DocNode; anchorBody: string | null }> {
  if (id?.trim()) {
    const parsed = expectDocId(id, ['page', 'section', 'chunk']);
    const ctx = { pgPool, schema, source: parsed.source };
    const pageId =
      parsed.kind === 'chunk'
        ? await pageIdOfChunk(ctx, parsed.chunkId)
        : parsed.pageId;
    const page = await loadPage(ctx, pageId);
    if (parsed.kind === 'page')
      return { node: pageNode(page), anchorBody: null };

    for (const section of page.sections) {
      if (parsed.kind === 'section' && section.index === parsed.sectionIndex)
        return { node: sectionNode(page, section), anchorBody: null };
      const chunk =
        parsed.kind === 'chunk'
          ? section.chunks.find((c) => c.id === parsed.chunkId)
          : undefined;
      if (chunk)
        return { node: sectionNode(page, section), anchorBody: chunk.body };
    }
    throw new Error(`${id} is not on page ${page.pageId}.`);
  }

  if (url?.trim()) {
    const source = sourceOfUrl(url.trim());
    if (!source)
      throw new Error(`${url} is not a URL of a docs source this server has.`);
    const ctx = { pgPool, schema, source };
    const page = await loadPage(ctx, await pageIdOfUrl(ctx, url.trim()));
    const section = sectionOfFragment(page, url);
    return {
      node: section ? sectionNode(page, section) : pageNode(page),
      anchorBody: null,
    };
  }

  throw new Error('Give an id or a url.');
}

const pageNode = (page: DocPage): DocNode => ({ kind: 'page', page });

export const getContextFactory: ApiFactory<
  ServerContext,
  typeof inputSchema,
  typeof outputSchema
> = (ctx) => ({
  name: 'get_context',
  method: 'get',
  route: '/context',
  config: {
    title: 'Read docs around a search hit',
    description: `Opens any part of the docs (a section or a whole page) as markdown, with links to move around it. Use it on a search_docs hit before answering from it: a hit is one chunk, and often a fragment (a table row without the header that says which column is which plan, one step of a procedure). Pass the hit's chunk_id to get the whole section it is in.

Every result is a node in the page's outline. parent_id goes one level up (to the enclosing section, then the page); children lists the sections one level down; previous_id / next_id move to the neighbouring sections. Pass any of those ids back in. It also takes a docs URL, e.g. a link in the text; a #fragment opens that section. Text over ${DOC_PART_MAX_CHARS.toLocaleString('en-US')} characters (a whole Postgres reference page, a long page) comes back in parts: you get the part holding the chunk you passed, and part / part_count say which.`,
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  fn: async ({
    id,
    url,
    part: passedPart,
  }): Promise<InferSchema<typeof outputSchema>> => {
    const { node, anchorBody } = await resolveNode(ctx, id, url);
    const { page } = node;

    const parts = splitIntoParts(textOf(node), DOC_PART_MAX_CHARS);
    const index = passedPart
      ? passedPart - 1
      : anchorBody
        ? partContaining(parts, anchorBody)
        : 0;
    if (index >= parts.length) {
      throw new Error(
        `${nodeIdOf(node)} has ${parts.length} part(s); part ${passedPart} does not exist.`,
      );
    }
    const headings = node.kind === 'section' ? node.section.headings : [];
    // A later part repeats the heading path so it reads on its own.
    const lead = headings.length
      ? `${headings.map(headingLine).join('\n\n')}\n\n`
      : `# ${page.title}\n\n`;
    const text =
      index === 0
        ? (parts[0] ?? '')
        : `${lead}_(part ${index + 1} of ${parts.length}, continued)_\n\n${parts[index]}`;

    const parent = parentOf(node);
    const { previous, next } = siblingsOf(node);
    // Child headings are shown relative to this node. A page's sections all
    // share the page's top headings (its H1, a PostGIS chapter), so a page
    // drops those.
    const depth =
      node.kind === 'section'
        ? node.section.headings.length
        : sharedHeadingDepth(page.sections);

    return {
      id: nodeIdOf(node),
      kind: node.kind,
      title: page.title,
      page_id: page.pageId,
      page_url: page.url,
      version: page.version,
      headings: headingTexts(headings),
      url: node.kind === 'section' ? node.section.url : page.url,
      text,
      part: index + 1,
      part_count: parts.length,
      parent_id: parent ? nodeIdOf(parent) : null,
      children: childrenOf(node).map((section) => {
        const child = sectionNode(page, section);
        return {
          id: nodeIdOf(child),
          heading: headingTexts(section.headings.slice(depth)).join(' > '),
          characters: subtreeOf(child).reduce((n, s) => n + s.body.length, 0),
        };
      }),
      previous_id: previous?.sectionId ?? null,
      next_id: next?.sectionId ?? null,
    };
  },
});
