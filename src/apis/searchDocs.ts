import { openai } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { trace } from '@opentelemetry/api';
import type { ApiFactory, InferSchema } from '@tigerdata/mcp-boilerplate';
import { type EmbeddingModel, embed } from 'ai';
import { z } from 'zod';
import type { ServerContext } from '../types.js';
import { headingsOf, headingTexts, parseMetadata } from '../util/docPages.js';
import {
  chunkIdOf,
  type DocSource,
  entityPrefixOf,
  pageIdOf,
  parseSearchSource,
  sectionIdOf,
} from '../util/docSources.js';
import type {
  KeywordChunkRow,
  SemanticChunkRow,
} from '../util/getDocChunkRows.js';
import {
  type GetDocChunkRowsContext,
  getDocChunkRows,
} from '../util/getDocChunkRows.js';
import { rrf } from '../util/rrf.js';

const SEARCH_DOCS_DEFAULT_LIMIT = 20;
const SEARCH_DOCS_DEFAULT_SEMANTIC_WEIGHT = 0.7;
const SEARCH_DOCS_HYBRID_CANDIDATE_POOL_FACTOR = 4;
const EMBEDDING_MODEL = 'text-embedding-3-small';

let embeddingModel: EmbeddingModel | null = null;

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
  chunk_id: z
    .string()
    .describe(
      'Id of this chunk. Pass it to get_context to read the whole section the chunk is in.',
    ),
  section_id: z
    .string()
    .describe('Id of the section this chunk is part of (get_context).'),
  page_id: z
    .string()
    .describe(
      'Id of the page this chunk is on (get_context: the page and its outline).',
    ),
  headings: z
    .array(z.string())
    .describe('Heading path of the section, page title first.'),
  url: z.string().nullable().describe('Link to the section on the docs site.'),
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

type SearchResult = SemanticResult | KeywordResult | HybridResult;

type NavigationFields = Pick<
  SearchResult,
  'chunk_id' | 'section_id' | 'page_id' | 'headings' | 'url'
>;

/** The ids and headings a hit needs for the follow-up tools. */
function navigationOf(
  source: DocSource,
  row: Pick<SemanticChunkRow, 'id' | 'page_id' | 'chunk_index' | 'metadata'>,
): NavigationFields {
  const metadata = parseMetadata(row.metadata);
  const sourceUrl = metadata.source_url;
  return {
    chunk_id: chunkIdOf(source, row.id),
    section_id: sectionIdOf(source, row.page_id, row.chunk_index),
    page_id: pageIdOf(source, row.page_id),
    headings: headingTexts(headingsOf(metadata)),
    url: typeof sourceUrl === 'string' ? sourceUrl : null,
  };
}

/** Drops the row's positional columns, which the ids already carry. */
function withNavigation<R extends SemanticChunkRow | KeywordChunkRow>(
  source: DocSource,
  row: R,
): Omit<R, 'page_id' | 'chunk_index' | 'sub_chunk_index'> & NavigationFields {
  const { page_id, chunk_index, sub_chunk_index, ...rest } = row;
  return { ...rest, ...navigationOf(source, row) };
}

const SEARCH_DOCS_SPAN_TOP_RESULT_COUNT = 3;

function getResultScore(result: SearchResult): number {
  if ('rrf_score' in result) return result.rrf_score;
  if ('score' in result) return result.score;
  return result.distance;
}

/**
 * Records the ids and scores of the top results onto the active span so the
 * search outcome is observable in Logfire. The matched document content is
 * intentionally excluded to keep span attributes small.
 */
function recordTopResultsOnSpan(results: SearchResult[]): void {
  const span = trace.getActiveSpan();
  if (!span) return;

  const topResults = results
    .slice(0, SEARCH_DOCS_SPAN_TOP_RESULT_COUNT)
    .map((result) => ({ id: result.id, score: getResultScore(result) }));

  span.setAttribute('search_docs.result_count', results.length);
  span.setAttribute('search_docs.top_results', JSON.stringify(topResults));
}

const getEmbeddingModel = () => {
  if (embeddingModel) {
    return embeddingModel;
  }

  if (process.env.OPENROUTER_API_KEY) {
    const openRouterProvider = createOpenRouter({
      apiKey: process.env.OPENROUTER_API_KEY,
    });
    embeddingModel = openRouterProvider.textEmbeddingModel(
      `openai/${EMBEDDING_MODEL}`,
    );
  } else {
    embeddingModel = openai.embedding(EMBEDDING_MODEL);
  }

  return embeddingModel;
};

async function embedQueryJson(query: string): Promise<string> {
  const { embedding } = await embed({
    model: getEmbeddingModel(),
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
    description: `Search documentation with hybrid semantic (vector) and keyword (BM25) search. Use semanticWeight to choose keyword-only (0), semantic-only (1), or a blend; mid values fuse rankings with RRF. Supports Tiger Cloud (TimescaleDB), PostgreSQL, and PostGIS.

A hit is one chunk of a page, often part of a larger section: a table row without its header, one step of a procedure. Before answering from a hit, read it in context: get_context with the hit's chunk_id returns the whole section it is in, and from there its parent section, the page and the page's outline. For exact figures (limits, prices, plan features) prefer keyword-heavy searches (semanticWeight 0–0.3) that use the words the docs would use.`,
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
    const { source, version } = parseSearchSource(passedSource);
    const entityPrefix = entityPrefixOf(source);

    const chunkRowsCtx: GetDocChunkRowsContext = {
      pgPool,
      schema,
      entityPrefix,
      version,
      semantic: false,
      searchParam: query,
      limit,
    };

    const semanticWeight =
      passedSemanticWeight ?? SEARCH_DOCS_DEFAULT_SEMANTIC_WEIGHT;

    if (semanticWeight === 0) {
      const rows = (await getDocChunkRows(chunkRowsCtx)) as KeywordChunkRow[];
      const results: KeywordResult[] = rows.map((r) =>
        withNavigation(source, r),
      );
      recordTopResultsOnSpan(results);
      return { results };
    }

    if (semanticWeight === 1) {
      const searchParam = await embedQueryJson(query);
      const rows = (await getDocChunkRows({
        ...chunkRowsCtx,
        semantic: true,
        searchParam,
      })) as SemanticChunkRow[];
      const results: SemanticResult[] = rows.map((r) =>
        withNavigation(source, r),
      );
      recordTopResultsOnSpan(results);
      return { results };
    }

    const hybridLimit = limit * SEARCH_DOCS_HYBRID_CANDIDATE_POOL_FACTOR;
    const [semanticRows, keywordRows] = await Promise.all([
      embedQueryJson(query).then((searchParam) =>
        getDocChunkRows({
          ...chunkRowsCtx,
          semantic: true,
          searchParam,
          limit: hybridLimit,
        }),
      ),
      getDocChunkRows({
        ...chunkRowsCtx,
        limit: hybridLimit,
      }),
    ]);

    const top = rrf({
      semanticIds: semanticRows.map((r) => r.id),
      keywordIds: keywordRows.map((r) => r.id),
      limit,
      semanticWeight,
    });

    const byId = new Map<number, SemanticChunkRow | KeywordChunkRow>();
    for (const r of [...semanticRows, ...keywordRows]) byId.set(r.id, r);

    const results: HybridResult[] = top.map(({ id, rrf_score }) => {
      const row = byId.get(id);
      if (!row) throw new Error(`Missing chunk row for id ${id}`);
      return {
        id,
        content: row.content,
        metadata: row.metadata ?? '',
        ...navigationOf(source, row),
        rrf_score,
      };
    });

    recordTopResultsOnSpan(results);
    return { results };
  },
  pickResult: (r) => r.results,
});
