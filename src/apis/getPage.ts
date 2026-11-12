import type { ApiFactory, InferSchema } from '@tigerdata/mcp-boilerplate';
import { z } from 'zod';
import type { ServerContext } from '../types.js';
import {
  headingTexts,
  loadPage,
  pageIdOfChunk,
  pageIdOfUrl,
  renderSections,
} from '../util/docPages.js';
import { expectDocId, sourceOfUrl } from '../util/docSources.js';

const inputSchema = {
  id: z
    .string()
    .nullable()
    .describe(
      'A page_id (e.g. "tiger:page:212"), or a section_id or chunk_id to get the page it is on. Give this or url.',
    ),
  url: z
    .string()
    .nullable()
    .describe(
      'A docs page URL (tigerdata.com/docs, postgresql.org/docs, postgis.net/docs). Any #fragment is ignored. Give this or id.',
    ),
  include_text: z
    .boolean()
    .nullable()
    .describe(
      'Return the whole page as markdown as well as its outline. Defaults to false: pages can be long, so read the outline first and open the sections you need with get_section.',
    ),
} as const;

const zSectionOutline = z.object({
  section_id: z.string(),
  headings: z
    .array(z.string())
    .describe('Heading path of the section, outermost first.'),
  url: z.string().nullable(),
  chunk_count: z.number().int(),
  characters: z.number().int().describe('Length of the section text.'),
});

const outputSchema = {
  page_id: z.string(),
  title: z.string(),
  url: z.string(),
  version: z
    .string()
    .nullable()
    .describe('Docs version, for versioned sources (Postgres, PostGIS).'),
  sections: z.array(zSectionOutline),
  text: z
    .string()
    .nullable()
    .describe('The whole page as markdown, only with include_text.'),
} as const;

export const getPageFactory: ApiFactory<
  ServerContext,
  typeof inputSchema,
  typeof outputSchema
> = ({ pgPool, schema }) => ({
  name: 'get_page',
  method: 'get',
  route: '/pages',
  config: {
    title: 'Get a docs page outline or full text',
    description: `Returns one docs page: its title, URL and outline (every section in order, with its section_id and size), and with include_text the whole page as markdown. Use it to see what else a page covers before opening sections with get_section, or to read a short page end to end. Takes a page_id, a section_id or chunk_id (for the page it is on), or a docs URL.`,
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  fn: async ({
    id,
    url,
    include_text: includeText,
  }): Promise<InferSchema<typeof outputSchema>> => {
    let page: Awaited<ReturnType<typeof loadPage>>;
    if (id?.trim()) {
      const parsed = expectDocId(id, ['page', 'section', 'chunk']);
      const ctx = { pgPool, schema, source: parsed.source };
      page = await loadPage(
        ctx,
        parsed.kind === 'chunk'
          ? await pageIdOfChunk(ctx, parsed.chunkId)
          : parsed.pageId,
      );
    } else if (url?.trim()) {
      const source = sourceOfUrl(url.trim());
      if (!source)
        throw new Error(
          `${url} is not a URL of a docs source this server has.`,
        );
      const ctx = { pgPool, schema, source };
      page = await loadPage(ctx, await pageIdOfUrl(ctx, url.trim()));
    } else {
      throw new Error('Give an id or a url.');
    }

    return {
      page_id: page.pageId,
      title: page.title,
      url: page.url,
      version: page.version,
      sections: page.sections.map((s) => ({
        section_id: s.sectionId,
        headings: headingTexts(s.headings),
        url: s.url,
        chunk_count: s.chunks.length,
        characters: s.body.length,
      })),
      text: includeText ? renderSections(page.sections) : null,
    };
  },
});
