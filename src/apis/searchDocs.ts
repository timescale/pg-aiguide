import { openai } from '@ai-sdk/openai';
import type { ApiFactory, InferSchema } from '@tigerdata/mcp-boilerplate';
import { embed } from 'ai';
import { z } from 'zod';
import type { ServerContext } from '../types.js';

type SourceType = 'tiger' | 'postgres' | 'postgis';
const ENTITY_NAME_MAPPINGS: Partial<Record<SourceType, string>> = {
  tiger: 'timescale',
};

/** RRF rank constant (standard default). */
const RRF_K = 60;

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
      'The type of search to perform. "semantic" uses natural language vector similarity, "keyword" uses BM25 keyword matching, "hybrid" combines both with reciprocal rank fusion (RRF).',
    ),
  query: z
    .string()
    .describe(
      'The search query. For semantic or hybrid search, use natural language. For keyword or hybrid search, the same text is also used for BM25 matching.',
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

const zHybridResult = zBaseResult.extend({
  rrf_score: z
    .number()
    .describe(
      'Reciprocal rank fusion score combining semantic and keyword rankings. Higher values indicate higher relevance.',
    ),
});

type SemanticResult = z.infer<typeof zSemanticResult>;
type KeywordResult = z.infer<typeof zKeywordResult>;
type HybridResult = z.infer<typeof zHybridResult>;

const outputSchema = {
  results: z.array(z.union([zSemanticResult, zKeywordResult, zHybridResult])),
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
      'Search documentation using semantic, keyword (BM25), or hybrid (RRF) search. Supports Tiger Cloud (TimescaleDB), PostgreSQL, and PostGIS.',
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

    if (!source) throw new Error('Invalid source');

    const prefix = ENTITY_NAME_MAPPINGS[source as SourceType] ?? source;
    const chunks = `${schema}.${prefix}_chunks`;
    const pages = `${schema}.${prefix}_pages`;
    const bm25Idx = `${schema}.${prefix}_chunks_content_idx`;
    const bm25 = (param: string) =>
      `c.content <@> to_bm25query(${param}, '${bm25Idx}')`;

    const isSemantic = search_type === 'semantic';
    const isHybrid = search_type === 'hybrid';

    const embeddingJson =
      isSemantic || isHybrid
        ? JSON.stringify(
            (
              await embed({
                model: openai.embedding('text-embedding-3-small'),
                value: query,
              })
            ).embedding,
          )
        : null;

    if (isHybrid) {
      const candidateLimit = Math.min(150, Math.max(limit * 4, 40));
      const vj = version
        ? `
        JOIN ${pages} p ON c.page_id = p.id
        WHERE p.version = $3`
        : '';
      const limCand = version ? '$4' : '$3';
      const limFinal = version ? '$5' : '$4';

      const sql = /* sql */ `
        WITH semantic_candidates AS (
          SELECT id, ROW_NUMBER() OVER (ORDER BY dist) AS sem_rank
          FROM (
            SELECT c.id, (c.embedding <=> $1::vector(1536)) AS dist
            FROM ${chunks} c
            ${vj}
            ORDER BY dist
            LIMIT ${limCand}
          ) s
        ),
        keyword_candidates AS (
          SELECT id, ROW_NUMBER() OVER (ORDER BY bm25_dist) AS kw_rank
          FROM (
            SELECT c.id, (${bm25('$2')}) AS bm25_dist
            FROM ${chunks} c
            ${vj}
            ORDER BY bm25_dist
            LIMIT ${limCand}
          ) k
        ),
        rrf_scores AS (
          SELECT
            COALESCE(s.id, k.id) AS id,
            COALESCE(1.0 / (${RRF_K} + s.sem_rank), 0)
              + COALESCE(1.0 / (${RRF_K} + k.kw_rank), 0) AS rrf_score
          FROM semantic_candidates s
          FULL OUTER JOIN keyword_candidates k ON s.id = k.id
        )
        SELECT c.id::int, c.content, c.metadata::text, r.rrf_score
        FROM rrf_scores r
        JOIN ${chunks} c ON c.id = r.id
        ORDER BY r.rrf_score DESC
        LIMIT ${limFinal}
        `;

      const params = version
        ? [embeddingJson, query, version, candidateLimit, limit]
        : [embeddingJson, query, candidateLimit, limit];

      const result = await pgPool.query<HybridResult>(sql, params);
      return { results: result.rows };
    }

    if (isSemantic && embeddingJson === null) {
      throw new Error('Expected embedding for semantic search.');
    }
    const searchParam = isSemantic ? embeddingJson : query;

    const vj = version
      ? `
        JOIN ${pages} p ON c.page_id = p.id
        WHERE p.version = $2`
      : '';
    const lim = version ? '$3' : '$2';

    const sql = /* sql */ `
        SELECT
          c.id::int,
          c.content,
          c.metadata::text,
          ${
            isSemantic
              ? `c.embedding <=> $1::vector(1536) AS distance`
              : `  -(${bm25('$1')}) AS score`
          }
        FROM ${chunks} c
        ${vj}
        ORDER BY ${isSemantic ? 'distance' : bm25('$1')}
        LIMIT ${lim}
        `;

    const params = [searchParam, ...(version ? [version] : []), limit];
    const result = await pgPool.query<SemanticResult | KeywordResult>(
      sql,
      params,
    );
    return { results: result.rows };
  },
  pickResult: (r) => r.results,
});
