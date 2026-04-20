import { openai } from '@ai-sdk/openai';
import type { ApiFactory, InferSchema } from '@tigerdata/mcp-boilerplate';
import { embed } from 'ai';
import { z } from 'zod';
import type { ServerContext } from '../types.js';
import { rrf } from './rrf.js';
import { tableSearch } from './tableSearch.js';

type SourceType = 'tiger' | 'postgres' | 'postgis';
const ENTITY_NAME_MAPPINGS: Partial<Record<SourceType, string>> = {
  tiger: 'timescale',
};

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
    .enum(['semantic', 'keyword', 'hybrid'])
    .describe(
      'The type of search to perform. "semantic" uses natural language vector similarity, "keyword" uses BM25 keyword matching, "hybrid" runs both and fuses rankings with RRF.',
    ),
  query: z
    .string()
    .describe(
      'The search query. For semantic search, use natural language. For keyword search, provide keywords. For hybrid, the same text is used for embedding and BM25.',
    ),
  limit: z.coerce
    .number()
    .int()
    .nullable()
    .describe(
      'The maximum number of matches to return. If not provided, default is 10.',
    ),
  keyword_weight: z.coerce
    .number()
    .finite()
    .nonnegative()
    .nullable()
    .optional()
    .describe(
      'Hybrid only: multiplier for BM25 ranks in RRF (default 1.0). Higher favors keyword matches.',
    ),
  semantic_weight: z.coerce
    .number()
    .finite()
    .nonnegative()
    .nullable()
    .optional()
    .describe(
      'Hybrid only: multiplier for vector ranks in RRF (default 1.0). Higher favors semantic matches.',
    ),
  rrf_k: z.coerce
    .number()
    .finite()
    .positive()
    .nullable()
    .optional()
    .describe(
      'Hybrid only: RRF smoothing constant k in weight/(k+rank) (default 60). Higher smooths rank differences.',
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

const zHybridResult = zBaseResult.extend({
  rrf_score: z
    .number()
    .describe(
      'Hybrid search: fused RRF score from combining semantic and keyword result rankings.',
    ),
});

type SemanticResult = z.infer<typeof zSemanticResult>;
type KeywordResult = z.infer<typeof zKeywordResult>;
type HybridResult = z.infer<typeof zHybridResult>;

const outputSchema = {
  results: z.array(z.union([zSemanticResult, zKeywordResult, zHybridResult])),
} as const;

type OutputSchema = InferSchema<typeof outputSchema>;

async function embedQueryJson(query: string): Promise<string> {
  const { embedding } = await embed({
    model: openai.embedding('text-embedding-3-small'),
    value: query,
  });
  return JSON.stringify(embedding);
}

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
      'Search documentation using semantic or keyword search, or hybrid (RRF). Supports Tiger Cloud (TimescaleDB), PostgreSQL, and PostGIS.',
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
    keyword_weight: passedKeywordWeight,
    semantic_weight: passedSemanticWeight,
    rrf_k: passedRrfK,
  }): Promise<OutputSchema> => {
    const limit = passedLimit != null ? passedLimit : 10;
    if (limit <= 0) {
      throw new Error('Limit must be a positive integer.');
    }

    if (!query.trim()) {
      throw new Error('Query must be a non-empty string.');
    }
    const [source, version] = passedSource.split('_');

    if (!source) throw new Error('Invalid source');

    const entityPrefix = ENTITY_NAME_MAPPINGS[source as SourceType] ?? source;

    switch (search_type) {
      case 'semantic': {
        const searchParam = await embedQueryJson(query);
        const result = await tableSearch({
          pool: pgPool,
          schema,
          entityPrefix,
          version: version ?? undefined,
          semantic: true,
          searchParam,
          limit: limit,
        });
        return { results: result as SemanticResult[] };
      }

      case 'keyword': {
        const result = await tableSearch({
          pool: pgPool,
          schema,
          entityPrefix,
          version: version ?? undefined,
          semantic: false,
          searchParam: query,
          limit,
        });
        return { results: result as KeywordResult[] };
      }

      case 'hybrid': {
        const searchParam = await embedQueryJson(query);

        const [semanticRows, keywordRows] = await Promise.all([
          tableSearch({
            pool: pgPool,
            schema,
            entityPrefix,
            version: version ?? undefined,
            semantic: true,
            searchParam,
            limit: limit * 4,
          }),
          tableSearch({
            pool: pgPool,
            schema,
            entityPrefix,
            version: version ?? undefined,
            semantic: false,
            searchParam: query,
            limit: limit * 4,
          }),
        ]);

        const top = rrf({
          semanticIds: semanticRows.map((r) => r.id),
          keywordIds: keywordRows.map((r) => r.id),
          limit,
          k: passedRrfK ?? undefined,
          semanticWeight: passedSemanticWeight ?? undefined,
          keywordWeight: passedKeywordWeight ?? undefined,
        });

        // Create a map of id to content and metadata for the results
        const byId = new Map<number, { content: string; metadata: string }>();
        for (const r of [...semanticRows, ...keywordRows]) {
          byId.set(r.id, {
            content: r.content,
            metadata: r.metadata ?? '',
          });
        }

        // Map the ids to the content and metadata
        const results = top.map(({ id, rrf_score }) => {
          const row = byId.get(id);
          if (!row) throw new Error(`Missing chunk row for id ${id}`);
          return {
            id,
            content: row.content,
            metadata: row.metadata,
            rrf_score,
          };
        });

        return { results: results as HybridResult[] };
      }
    }
  },
  pickResult: (r) => r.results,
});
