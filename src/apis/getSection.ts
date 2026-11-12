import type { ApiFactory, InferSchema } from '@tigerdata/mcp-boilerplate';
import { z } from 'zod';
import type { ServerContext } from '../types.js';
import {
  headingTexts,
  loadPage,
  pageIdOfChunk,
  renderSections,
  subsectionsOf,
} from '../util/docPages.js';
import { expectDocId } from '../util/docSources.js';

const inputSchema = {
  id: z
    .string()
    .min(1)
    .describe(
      'A section_id (e.g. "tiger:section:212.9"), or a chunk_id to get the section that chunk belongs to.',
    ),
  include_subsections: z
    .boolean()
    .nullable()
    .describe(
      'Also include the sections nested under this one (an H2 with its H3s). Defaults to false.',
    ),
} as const;

const outputSchema = {
  section_id: z.string(),
  page_id: z.string(),
  title: z.string().describe('Page title.'),
  page_url: z.string(),
  headings: z
    .array(z.string())
    .describe('Heading path of the section, outermost first.'),
  url: z.string().nullable().describe('Link to the section on the docs site.'),
  text: z
    .string()
    .describe(
      'The whole section as markdown, led by its parent headings so it reads on its own.',
    ),
  chunk_ids: z
    .array(z.string())
    .describe('The chunks the text was built from.'),
  subsection_ids: z
    .array(z.string())
    .describe(
      'Sections nested under this one. Their text is included only with include_subsections.',
    ),
  previous_section_id: z.string().nullable(),
  next_section_id: z.string().nullable(),
} as const;

export const getSectionFactory: ApiFactory<
  ServerContext,
  typeof inputSchema,
  typeof outputSchema
> = ({ pgPool, schema }) => ({
  name: 'get_section',
  method: 'get',
  route: '/sections',
  config: {
    title: 'Get a whole docs section',
    description: `Returns one section of a docs page in full: the text under one heading, with its parent headings, rebuilt from all of its chunks. Use it when a search_docs hit is part of something larger (a table, a list of limits, a procedure) and you need all of it, e.g. the header row that says which column is which plan. Takes a section_id, or a chunk_id for the section that chunk is in. previous_section_id / next_section_id step through the page; get_page lists every section.`,
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  fn: async ({
    id,
    include_subsections: includeSubsections,
  }): Promise<InferSchema<typeof outputSchema>> => {
    const parsed = expectDocId(id, ['section', 'chunk']);
    const ctx = { pgPool, schema, source: parsed.source };
    const pageId =
      parsed.kind === 'section'
        ? parsed.pageId
        : await pageIdOfChunk(ctx, parsed.chunkId);
    const page = await loadPage(ctx, pageId);

    const at = page.sections.findIndex((s) =>
      parsed.kind === 'section'
        ? s.index === parsed.sectionIndex
        : s.chunks.some((c) => c.id === parsed.chunkId),
    );
    const section = page.sections[at];
    if (!section) throw new Error(`No section ${id} on page ${page.pageId}.`);

    const subsections = subsectionsOf(page, section);
    const included = includeSubsections ? [section, ...subsections] : [section];
    const last = page.sections.indexOf(included.at(-1) ?? section);

    return {
      section_id: section.sectionId,
      page_id: page.pageId,
      title: page.title,
      page_url: page.url,
      headings: headingTexts(section.headings),
      url: section.url,
      // renderSections leads with the first section's parent headings.
      text: renderSections(included),
      chunk_ids: included.flatMap((s) => s.chunks.map((c) => c.chunkId)),
      subsection_ids: subsections.map((s) => s.sectionId),
      previous_section_id: page.sections[at - 1]?.sectionId ?? null,
      next_section_id: page.sections[last + 1]?.sectionId ?? null,
    };
  },
});
