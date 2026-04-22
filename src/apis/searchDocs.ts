import { openai } from '@ai-sdk/openai';
import type { ApiFactory, InferSchema } from '@tigerdata/mcp-boilerplate';
import { embed } from 'ai';
import { z } from 'zod';
import type { ServerContext } from '../types.js';
import { rrf } from './rrf.js';
import { type TableSearchContext, tableSearch } from './tableSearch.js';

type SourceType = 'tiger' | 'postgres' | 'postgis';
const ENTITY_NAME_MAPPINGS: Partial<Record<SourceType, string>> = {
  tiger: 'timescale',
};

const SEARCH_DOCS_DEFAULT_LIMIT = 20;
const SEARCH_DOCS_DEFAULT_SEMANTIC_WEIGHT = 0.7;
const SEARCH_DOCS_HYBRID_CANDIDATE_POOL_FACTOR = 4;

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
  query: z
    .string()
    .describe(
      'The search query. Used for BM25 when keyword or hybrid search applies, and for the embedding when semantic or hybrid search applies.',
    ),
  limit: z.coerce
    .number()
    .int()
    .nullable()
    .describe(
      `The maximum number of matches to return. Defaults to ${SEARCH_DOCS_DEFAULT_LIMIT}.`,
    ),
  semanticWeight: z
    .number()
    .multipleOf(0.1)
    .min(0)
    .max(1)
    .nullable()
    .describe(
      `Controls the balance between semantic and keyword search. 0 = keyword only, 0.5 = equal mix, 1 = semantic only. Default is ${SEARCH_DOCS_DEFAULT_SEMANTIC_WEIGHT} (favor semantic search).`,
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
      'Search documentation with hybrid semantic (vector) and keyword (BM25) search. Use semanticWeight to choose keyword-only (0), semantic-only (1), or a blend; mid values fuse rankings with RRF. Supports Tiger Cloud (TimescaleDB), PostgreSQL, and PostGIS.',
    inputSchema,
    outputSchema,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
  },
  fn: async ({
    source: passedSource,
    query,
    limit: passedLimit,
    semanticWeight: passedSemanticWeight,
  }): Promise<OutputSchema> => {
    const limit = passedLimit ?? SEARCH_DOCS_DEFAULT_LIMIT;
    if (limit <= 0) {
      throw new Error('Limit must be a positive integer.');
    }

    if (!query.trim()) {
      throw new Error('Query must be a non-empty string.');
    }
    const [source, version] = passedSource.split('_');

    if (!source) throw new Error('Invalid source');

    const entityPrefix = ENTITY_NAME_MAPPINGS[source as SourceType] ?? source;

    const tableSearchCtx = {
      pool: pgPool,
      schema,
      entityPrefix,
      version: version ?? undefined,
      semantic: false,
      searchParam: query,
      limit,
    };

    const semanticWeight =
      passedSemanticWeight ?? SEARCH_DOCS_DEFAULT_SEMANTIC_WEIGHT;

    if (semanticWeight === 0) {
      const result = await tableSearch({ ...tableSearchCtx });
      return { results: result as KeywordResult[] };
    }

    if (semanticWeight === 1) {
      const searchParam = await embedQueryJson(query);
      const result = await tableSearch({
        ...tableSearchCtx,
        semantic: true,
        searchParam,
      });
      return { results: result as SemanticResult[] };
    }

    const hybridLimit = limit * SEARCH_DOCS_HYBRID_CANDIDATE_POOL_FACTOR;
    const [semanticRows, keywordRows] = await Promise.all([
      embedQueryJson(query).then((searchParam) =>
        tableSearch({
          ...tableSearchCtx,
          semantic: true,
          searchParam,
          limit: hybridLimit,
        }),
      ),
      tableSearch({
        ...tableSearchCtx,
        limit: hybridLimit,
      }),
    ]);

    const top = rrf({
      semanticIds: semanticRows.map((r) => r.id),
      keywordIds: keywordRows.map((r) => r.id),
      limit,
      semanticWeight,
    });

    const byId = new Map<number, { content: string; metadata: string }>();
    for (const r of [...semanticRows, ...keywordRows]) {
      byId.set(r.id, {
        content: r.content,
        metadata: r.metadata ?? '',
      });
    }

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
  },
  pickResult: (r) => r.results,
});
