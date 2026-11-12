import type { ApiFactory, InferSchema } from '@tigerdata/mcp-boilerplate';
import { z } from 'zod';
import type { ServerContext } from '../types.js';
import {
  headingLine,
  headingTexts,
  loadPage,
  pageIdOfChunk,
  partContaining,
  renderSections,
  splitIntoParts,
  subsectionsOf,
} from '../util/docPages.js';
import { expectDocId } from '../util/docSources.js';

/** Sections longer than this (about 5,000 tokens) are returned a part at a time. */
export const SECTION_PART_MAX_CHARS = 20_000;

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
  part: z
    .number()
    .int()
    .min(1)
    .nullable()
    .describe(
      'Which part to return when the section is split into parts (part_count > 1). Defaults to the part holding the chunk you passed, or part 1 for a section_id.',
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
      'The section as markdown, led by its parent headings so it reads on its own. When part_count > 1 this is one part of it.',
    ),
  part: z.number().int().describe('Which part `text` is, from 1.'),
  part_count: z
    .number()
    .int()
    .describe(
      'How many parts the section is split into. Above 1, call again with `part` for the rest.',
    ),
  chunk_ids: z
    .array(z.string())
    .describe('The chunks the whole section was built from.'),
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
    description: `Returns one section of a docs page in full: the text under one heading, with its parent headings, rebuilt from all of its chunks. Use it when a search_docs hit is part of something larger (a table, a list of limits, a procedure) and you need all of it, e.g. the header row that says which column is which plan. Takes a section_id, or a chunk_id for the section that chunk is in. A very long section (over ${SECTION_PART_MAX_CHARS.toLocaleString('en-US')} characters, e.g. a whole Postgres reference page) comes back in parts: you get the part holding the chunk you passed, and part / part_count say which. previous_section_id / next_section_id step through the page; get_page lists every section.`,
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  fn: async ({
    id,
    include_subsections: includeSubsections,
    part: passedPart,
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

    // renderSections leads with the first section's parent headings.
    const parts = splitIntoParts(
      renderSections(included),
      SECTION_PART_MAX_CHARS,
    );
    const anchor =
      parsed.kind === 'chunk'
        ? section.chunks.find((c) => c.id === parsed.chunkId)
        : undefined;
    const index = passedPart
      ? passedPart - 1
      : anchor
        ? partContaining(parts, anchor.body)
        : 0;
    if (index >= parts.length) {
      throw new Error(
        `Section ${section.sectionId} has ${parts.length} part(s); part ${passedPart} does not exist.`,
      );
    }
    // A later part repeats the heading path so it reads on its own.
    const lead = section.headings.map(headingLine).join('\n\n');
    const text =
      index === 0
        ? (parts[0] ?? '')
        : `${lead}\n\n_(part ${index + 1} of ${parts.length}, continued)_\n\n${parts[index]}`;

    return {
      section_id: section.sectionId,
      page_id: page.pageId,
      title: page.title,
      page_url: page.url,
      headings: headingTexts(section.headings),
      url: section.url,
      text,
      part: index + 1,
      part_count: parts.length,
      chunk_ids: included.flatMap((s) => s.chunks.map((c) => c.chunkId)),
      subsection_ids: subsections.map((s) => s.sectionId),
      previous_section_id: page.sections[at - 1]?.sectionId ?? null,
      next_section_id: page.sections[last + 1]?.sectionId ?? null,
    };
  },
});
