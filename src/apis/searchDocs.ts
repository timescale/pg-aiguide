import { openai } from '@ai-sdk/openai';
import type { ApiFactory, InferSchema } from '@tigerdata/mcp-boilerplate';
import { embed } from 'ai';
import { z } from 'zod';
import type { ServerContext } from '../types.js';

const inputSchema = {
  source: z
    .enum([
      'tiger',
      'postgres_14',
      'postgres_15',
      'postgres_16',
      'postgres_17',
      'postgres_18',
      'postgis_3.3',
      'postgis_3.4',
      'postgis_3.5',
      'postgis_3.6',
    ])
    .describe(
      'The documentation source to search. "tiger" for Tiger Cloud and TimescaleDB, "postgres" for PostgreSQL, "postgis" for PostGIS spatial extension. Specific versions provided with _X.X suffixes.',
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
  limit: z.coerce
    .number()
    .int()
    .nullable()
    .describe(
      'The maximum number of matches to return. If not provided, default is 10.',
    ),
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
      'Search documentation using semantic or keyword search. Supports Tiger Cloud (TimescaleDB), PostgreSQL, and PostGIS.',
    inputSchema,
    outputSchema,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
  },
  fn: async ({
    source: passedSource,
    search_type,
    query,
    limit: passedLimit,
  }): Promise<OutputSchema> => {
    const limit = passedLimit != null ? passedLimit : 10;
    if (limit <= 0) {
      throw new Error('Limit must be a positive integer.');
    }

    if (!query.trim()) {
      throw new Error('Query must be a non-empty string.');
    }
    const [source, version] = passedSource.split('_');
    const entityPrefix = source === 'tiger' ? 'timescale' : source;
    const isTiger = source === 'tiger';
    if (search_type === 'semantic') {
      const { embedding } = await embed({
        model: openai.embedding('text-embedding-3-small'),
        value: query,
      });

      const result = await pgPool.query<SemanticResult>(
        /* sql */ `
        SELECT
          c.id::int,
          c.content,
          c.metadata::text,
          c.embedding <=> $1::vector(1536) AS distance
        FROM ${schema}.${entityPrefix}_chunks c
        ${
          !isTiger
            ? `JOIN ${schema}.${entityPrefix}_pages p ON c.page_id = p.id
        WHERE p.version = $2`
            : ``
        }
        ORDER BY distance
        LIMIT $${isTiger ? '2' : '3'}
        `,
        [JSON.stringify(embedding), ...(!isTiger ? [version] : []), limit],
      );
      return { results: result.rows };
    } else if (search_type === 'keyword') {
      const result = await pgPool.query<KeywordResult>(
        /* sql */ `
          SELECT
            c.id::int,
            c.content,
            c.metadata::text,
            -(c.content <@> to_bm25query($1, '${schema}.${entityPrefix}_chunks_content_idx')) as score
          FROM ${schema}.${entityPrefix}_chunks c
          ${
            !isTiger
              ? `JOIN ${schema}.${entityPrefix}_pages p ON c.page_id = p.id
          WHERE p.version = $2`
              : ''
          }
          
          ORDER BY c.content <@> to_bm25query($1, '${schema}.${entityPrefix}_chunks_content_idx')
          LIMIT $${isTiger ? '2' : '3'}
          `,
        [query, ...(!isTiger ? [version] : []), limit],
      );

      return { results: result.rows };
    } else {
      // @ts-expect-error exhaustive cases
      throw new Error(`Unsupported search_type: ${search_type.toString()}`);
    }
  },
  pickResult: (r) => r.results,
});
