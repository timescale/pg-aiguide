import type { ApiFactory, InferSchema } from '@tigerdata/mcp-boilerplate';
import { z } from 'zod';
import type { ServerContext } from '../types.js';
import {
  headingTexts,
  joinSubChunks,
  loadPage,
  pageIdOfChunk,
} from '../util/docPages.js';
import { expectDocId } from '../util/docSources.js';

export const SURROUNDING_CHUNKS_DEFAULT = 2;
export const SURROUNDING_CHUNKS_MAX = 10;

const inputSchema = {
  chunk_id: z
    .string()
    .min(1)
    .describe('A chunk_id from a search_docs hit, e.g. "tiger:chunk:4483".'),
  neighbors: z
    .number()
    .int()
    .min(0)
    .max(SURROUNDING_CHUNKS_MAX)
    .nullable()
    .describe(
      `How many chunks to include on each side of the anchor, within the same page. Defaults to ${SURROUNDING_CHUNKS_DEFAULT}.`,
    ),
} as const;

const zChunkOut = z.object({
  chunk_id: z.string(),
  section_id: z.string(),
  headings: z
    .array(z.string())
    .describe('Heading path of the section, outermost first.'),
  url: z.string().nullable().describe('Link to the section on the docs site.'),
  is_anchor: z.boolean(),
  text: z
    .string()
    .describe(
      'Chunk text without the repeated parent headings, and without the text it shares with the previous chunk of the same section.',
    ),
});

const outputSchema = {
  page_id: z.string(),
  title: z.string(),
  page_url: z.string(),
  anchor_chunk_id: z.string(),
  chunks: z.array(zChunkOut),
} as const;

export const getSurroundingChunksFactory: ApiFactory<
  ServerContext,
  typeof inputSchema,
  typeof outputSchema
> = ({ pgPool, schema }) => ({
  name: 'get_surrounding_chunks',
  method: 'get',
  route: '/chunks/context',
  config: {
    title: 'Get a docs chunk with the chunks around it',
    description: `Returns a search_docs hit and its neighbouring chunks on the same page, in reading order, so a hit that starts mid-table or mid-list can be read with what comes before and after it (the table's header row, the step before). For the whole section a hit belongs to, use get_section with its section_id; for the page's outline, get_page.`,
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  fn: async ({
    chunk_id: chunkIdArg,
    neighbors: passedNeighbors,
  }): Promise<InferSchema<typeof outputSchema>> => {
    const { source, chunkId } = expectDocId(chunkIdArg, ['chunk']);
    const neighbors = passedNeighbors ?? SURROUNDING_CHUNKS_DEFAULT;
    const ctx = { pgPool, schema, source };
    const page = await loadPage(ctx, await pageIdOfChunk(ctx, chunkId));

    const ordered = page.sections.flatMap((section) =>
      section.chunks.map((chunk) => ({ section, chunk })),
    );
    const at = ordered.findIndex(({ chunk }) => chunk.id === chunkId);
    if (at < 0) throw new Error(`Chunk ${chunkIdArg} is not on its page.`);
    const window = ordered.slice(
      Math.max(0, at - neighbors),
      at + neighbors + 1,
    );

    return {
      page_id: page.pageId,
      title: page.title,
      page_url: page.url,
      anchor_chunk_id: chunkIdArg,
      chunks: window.map(({ section, chunk }, i) => {
        const prev = window[i - 1];
        // Drop the text this chunk repeats from the previous sub-chunk.
        const text =
          prev && prev.section === section && source === 'tiger'
            ? joinSubChunks([prev.chunk.body, chunk.body], true).text.slice(
                prev.chunk.body.length,
              )
            : chunk.body;
        return {
          chunk_id: chunk.chunkId,
          section_id: section.sectionId,
          headings: headingTexts(section.headings),
          url: section.url,
          is_anchor: chunk.id === chunkId,
          text: text.replace(/^\n/, ''),
        };
      }),
    };
  },
});
