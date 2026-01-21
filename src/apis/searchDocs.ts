import { openai } from '@ai-sdk/openai';
import type { ApiFactory, InferSchema } from '@tigerdata/mcp-boilerplate';
import { embed } from 'ai';
import { z } from 'zod';
import type { ServerContext } from '../types.js';

const pg_versions = ['14', '15', '16', '17', '18'] as const;
const latest_pg_version = pg_versions.at(-1) as (typeof pg_versions)[number];
const versions = [...pg_versions, 'latest'] as const;

const inputSchema = {
  source: z
    .enum(['tiger', 'postgres'])
    .describe(
      'The documentation source to search. "tiger" for Tiger Cloud and TimescaleDB, "postgres" for PostgreSQL.',
    ),
  search_type: z
    .enum(['semantic', 'keyword'])
    .describe(
      'The type of search to perform. "semantic" uses natural language vector similarity, "keyword" uses BM25 keyword matching.',
    ),
  query: z
    .string()
    .describe(
      'The search query. For semantic search, use natural language. For keyword search, provide keywords.',
    ),
  version: z
    .enum(versions)
    .describe(
      'The PostgreSQL major version (ignored when searching "tiger"). Recommended to assume the latest version if unknown.',
    ),
  limit: z.coerce
    .number()
    .int()
    .describe('The maximum number of matches to return. Default is 10.'),
} as const;

const zBaseResult = z.object({
  id: z
    .number()
    .int()
    .describe('The unique identifier of the documentation entry.'),
  content: z.string().describe('The content of the documentation entry.'),
  metadata: z
    .string()
    .describe(
      'Additional metadata about the documentation entry, as a JSON encoded string.',
    ),
});

const zSemanticResult = zBaseResult.extend({
  distance: z
    .number()
    .describe(
      'The distance score indicating the relevance of the entry to the query. Lower values indicate higher relevance.',
    ),
});

const zKeywordResult = zBaseResult.extend({
  score: z
    .number()
    .describe(
      'The score indicating the relevance of the entry to the keywords. Higher values indicate higher relevance.',
    ),
});

type SemanticResult = z.infer<typeof zSemanticResult>;
type KeywordResult = z.infer<typeof zKeywordResult>;

const outputSchema = {
  results: z.array(z.union([zSemanticResult, zKeywordResult])),
} as const;

type OutputSchema = InferSchema<typeof outputSchema>;

export const searchDocsFactory: ApiFactory<
  ServerContext,
  typeof inputSchema,
  typeof outputSchema,
  z.infer<(typeof outputSchema)['results']>
> = ({ pgPool, schema }) => ({
  name: 'search_docs',
  method: 'get',
  route: '/search-docs',
  config: {
    title: 'Search Documentation',
    description:
      'Search documentation using semantic or keyword search. Supports Tiger Cloud (TimescaleDB) and PostgreSQL.',
    inputSchema,
    outputSchema,
  },
  fn: async ({
    source,
    search_type,
    query,
    version: passedVersion,
    limit: passedLimit,
  }): Promise<OutputSchema> => {
    const limit = passedLimit > 0 ? passedLimit : 10;

    if (!query.trim()) {
      throw new Error('Query must be a non-empty string.');
    }

    const version =
      passedVersion === 'latest' ? latest_pg_version : passedVersion;

    if (search_type === 'semantic') {
      const { embedding } = await embed({
        model: openai.embedding('text-embedding-3-small'),
        value: query,
      });

      if (source === 'tiger') {
        const result = await pgPool.query<SemanticResult>(
          /* sql */ `
SELECT
  id::int,
  content,
  metadata::text,
  embedding <=> $1::vector(1536) AS distance
 FROM ${schema}.timescale_chunks
 ORDER BY distance
 LIMIT $2
`,
          [JSON.stringify(embedding), limit],
        );
        return { results: result.rows };
      } else if (source === 'postgres') {
        // postgres
        const result = await pgPool.query<SemanticResult>(
          /* sql */ `
SELECT
  c.id::int,
  c.content,
  c.metadata::text,
  c.embedding <=> $1::vector(1536) AS distance
 FROM ${schema}.postgres_chunks c
 JOIN ${schema}.postgres_pages p ON c.page_id = p.id
 WHERE p.version = $2
 ORDER BY distance
 LIMIT $3
`,
          [JSON.stringify(embedding), version, limit],
        );
        return { results: result.rows };
      } else {
        // @ts-expect-error exhaustive cases
        throw new Error(`Unsupported source: ${source.toString()}`);
      }
    } else if (search_type === 'keyword') {
      if (source === 'tiger') {
        const result = await pgPool.query<KeywordResult>(
          /* sql */ `
SELECT
  id::int,
  content,
  metadata::text,
  -(content <@> to_bm25query($1, '${schema}.timescale_chunks_content_idx')) as score
 FROM ${schema}.timescale_chunks
 ORDER BY content <@> to_bm25query($1, '${schema}.timescale_chunks_content_idx')
 LIMIT $2
`,
          [query, limit],
        );
        return { results: result.rows };
      } else if (source === 'postgres') {
        const result = await pgPool.query<KeywordResult>(
          /* sql */ `
SELECT
  c.id::int,
  c.content,
  c.metadata::text,
  -(c.content <@> to_bm25query($1, '${schema}.postgres_chunks_content_idx')) as score
 FROM ${schema}.postgres_chunks c
 JOIN ${schema}.postgres_pages p ON c.page_id = p.id
 WHERE p.version = $2
 ORDER BY c.content <@> to_bm25query($1, '${schema}.postgres_chunks_content_idx')
 LIMIT $3
`,
          [query, version, limit],
        );

        return { results: result.rows };
      } else {
        // @ts-expect-error exhaustive cases
        throw new Error(`Unsupported source: ${source.toString()}`);
      }
    } else {
      // @ts-expect-error exhaustive cases
      throw new Error(`Unsupported search_type: ${search_type.toString()}`);
    }
  },
  pickResult: (r) => r.results,
});
