import { openai } from '@ai-sdk/openai';
import type { ApiFactory, InferSchema } from '@tigerdata/mcp-boilerplate';
import { embed } from 'ai';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { ServerContext } from '../types.js';

// --- constants & source routing

type SourceType = 'tiger' | 'postgres' | 'postgis';
const ENTITY_NAME_MAPPINGS: Partial<Record<SourceType, string>> = {
  tiger: 'timescale',
};

const RRF_K = 60;

// --- Zod: request / response (MCP + HTTP)

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

// --- DB + RRF primitives

type SearchDocsCtx = {
  pool: Pool;
  schema: string;
  entityPrefix: string;
  version?: string;
};

/** RRF from two ordered id lists (rank 1 = index 0). */
function rrfScores(
  semanticIds: number[],
  keywordIds: number[],
): Map<number, number> {
  const scores = new Map<number, number>();
  const add = (ids: number[]) => {
    ids.forEach((id, i) => {
      const r = i + 1;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + r));
    });
  };
  add(semanticIds);
  add(keywordIds);
  return scores;
}

async function searchDocsQuery(
  pool: Pool,
  schema: string,
  entityPrefix: string,
  semantic: boolean,
  searchParam: string,
  limit: number,
  version?: string,
): Promise<Record<string, unknown>[]> {
  const bm25Idx = `${schema}.${entityPrefix}_chunks_content_idx`;
  const sql = /* sql */ `
        SELECT
          c.id::int,
          c.content,
          c.metadata::text,
          ${
            semantic
              ? `c.embedding <=> $1::vector(1536) AS distance`
              : `  -(c.content <@> to_bm25query($1, '${bm25Idx}')) as score`
          }
        FROM ${schema}.${entityPrefix}_chunks c
        ${
          version
            ? `JOIN ${schema}.${entityPrefix}_pages p ON c.page_id = p.id
        WHERE p.version = $2`
            : ``
        }
        ORDER BY ${
          semantic ? 'distance' : `c.content <@> to_bm25query($1, '${bm25Idx}')`
        }
        LIMIT $${version ? '3' : '2'}
        `;

  const result = await pool.query(sql, [
    searchParam,
    ...(version ? [version] : []),
    limit,
  ]);
  return result.rows;
}

async function embeddingJsonForQuery(query: string): Promise<string> {
  const { embedding } = await embed({
    model: openai.embedding('text-embedding-3-small'),
    value: query,
  });
  return JSON.stringify(embedding);
}

// --- One explicit implementation per search_type

/** Vector similarity only; returns rows with `distance`. */
async function runSemanticDocsSearch(
  ctx: SearchDocsCtx,
  query: string,
  limit: number,
): Promise<SemanticResult[]> {
  const embeddingJson = await embeddingJsonForQuery(query);
  const rows = await searchDocsQuery(
    ctx.pool,
    ctx.schema,
    ctx.entityPrefix,
    true,
    embeddingJson,
    limit,
    ctx.version,
  );
  return rows as SemanticResult[];
}

/** BM25 / keyword index only; returns rows with `score`. */
async function runKeywordDocsSearch(
  ctx: SearchDocsCtx,
  query: string,
  limit: number,
): Promise<KeywordResult[]> {
  const rows = await searchDocsQuery(
    ctx.pool,
    ctx.schema,
    ctx.entityPrefix,
    false,
    query,
    limit,
    ctx.version,
  );
  return rows as KeywordResult[];
}

/**
 * Parallel semantic + keyword top-k, RRF fusion in app code, then load chunk
 * text for the fused id list. Returns rows with `rrf_score` only (no distance/score).
 */
async function runHybridDocsSearch(
  ctx: SearchDocsCtx,
  query: string,
  limit: number,
): Promise<HybridResult[]> {
  const embeddingJson = await embeddingJsonForQuery(query);
  const candidateLimit = Math.min(150, Math.max(limit * 4, 40));

  const [semanticRows, keywordRows] = await Promise.all([
    searchDocsQuery(
      ctx.pool,
      ctx.schema,
      ctx.entityPrefix,
      true,
      embeddingJson,
      candidateLimit,
      ctx.version,
    ),
    searchDocsQuery(
      ctx.pool,
      ctx.schema,
      ctx.entityPrefix,
      false,
      query,
      candidateLimit,
      ctx.version,
    ),
  ]);

  const scores = rrfScores(
    semanticRows.map((r) => r.id as number),
    keywordRows.map((r) => r.id as number),
  );
  const top = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, rrf_score]) => ({ id, rrf_score }));

  const { rows: chunks } = await ctx.pool.query<{
    id: number;
    content: string;
    metadata: string;
  }>(
    /* sql */ `
        SELECT id::int, content, metadata::text
        FROM ${ctx.schema}.${ctx.entityPrefix}_chunks
        WHERE id = ANY($1::int[])
        `,
    [top.map((t) => t.id)],
  );
  const byId = new Map(chunks.map((c) => [c.id, c]));

  return top.map(({ id, rrf_score }) => {
    const row = byId.get(id);
    if (!row) throw new Error(`Missing chunk row for id ${id}`);
    return { ...row, rrf_score };
  });
}

// --- API factory

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

    const entityPrefix = ENTITY_NAME_MAPPINGS[source as SourceType] ?? source;
    const ctx: SearchDocsCtx = {
      pool: pgPool,
      schema,
      entityPrefix,
      version: version || undefined,
    };

    switch (search_type) {
      case 'semantic':
        return { results: await runSemanticDocsSearch(ctx, query, limit) };

      case 'keyword':
        return { results: await runKeywordDocsSearch(ctx, query, limit) };

      case 'hybrid':
        return { results: await runHybridDocsSearch(ctx, query, limit) };

      default: {
        const _exhaustive: never = search_type;
        throw new Error(`Unhandled search_type: ${_exhaustive}`);
      }
    }
  },
  pickResult: (r) => r.results,
});
