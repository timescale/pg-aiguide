import { z } from 'zod';

export const pg_versions = ['14', '15', '16', '17', '18'] as const;
export const latest_pg_version = pg_versions.at(
  -1,
) as (typeof pg_versions)[number];
export const versions = [...pg_versions, 'latest'] as const;

export const inputSchema = {
  source: z
    .enum(['tiger', 'postgres', 'postgis'])
    .describe(
      'The documentation source to search. "tiger" for Tiger Cloud and TimescaleDB, "postgres" for PostgreSQL, "postgis" for PostGIS spatial extension.',
    ),
  search_type: z
    .enum(['semantic', 'keyword', 'hybrid'])
    .describe(
      'The type of search to perform. "semantic" uses natural language vector similarity, "keyword" uses BM25 keyword matching, "hybrid" combines both with reciprocal rank fusion (RRF).',
    ),
  query: z
    .string()
    .describe(
      'The search query. For semantic search, use natural language. For keyword search, provide keywords.',
    ),
  version: z
    .enum(versions)
    .nullable()
    .describe(
      'The PostgreSQL major version (ignored when searching "tiger"). Recommended to assume the latest version if unknown. Only applicable when source is Postgres. Defaults to latest version.',
    ),
  limit: z.coerce
    .number()
    .int()
    .describe('The maximum number of matches to return. Default is 10.'),
} as const;

export const zBaseResult = z.object({
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

export const zSemanticResult = zBaseResult.extend({
  distance: z
    .number()
    .describe(
      'The distance score indicating the relevance of the entry to the query. Lower values indicate higher relevance.',
    ),
});

export const zKeywordResult = zBaseResult.extend({
  score: z
    .number()
    .describe(
      'The score indicating the relevance of the entry to the keywords. Higher values indicate higher relevance.',
    ),
});

export const zHybridResult = zBaseResult.extend({
  rrf_score: z
    .number()
    .describe(
      'Reciprocal rank fusion score combining semantic and keyword rankings. Higher values indicate higher relevance.',
    ),
});

export type SemanticResult = z.infer<typeof zSemanticResult>;
export type KeywordResult = z.infer<typeof zKeywordResult>;
export type HybridResult = z.infer<typeof zHybridResult>;
export type BaseResult = z.infer<typeof zBaseResult>;
export type DocsSource = z.infer<(typeof inputSchema)['source']>;

export const outputSchema = {
  results: z.array(z.union([zSemanticResult, zKeywordResult, zHybridResult])),
} as const;
