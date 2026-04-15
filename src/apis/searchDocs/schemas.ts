import { z } from 'zod';

export const pg_versions = ['14', '15', '16', '17', '18'] as const;
export const latest_pg_version = pg_versions.at(
  -1,
) as (typeof pg_versions)[number];

/** Logical source for routing queries (maps to table prefix via ENTITY_NAME_MAPPINGS). */
export type DocsBaseSource = 'tiger' | 'postgres' | 'postgis';

/**
 * API `source` values: version is encoded in the suffix (e.g. postgres_17, postgis_3.4).
 * Use postgres_latest for the newest bundled Postgres manual version.
 */
export const docsSourceEnumValues = [
  'tiger',
  'postgres_14',
  'postgres_15',
  'postgres_16',
  'postgres_17',
  'postgres_18',
  'postgres_latest',
  'postgis_3.3',
  'postgis_3.4',
  'postgis_3.5',
  'postgis_3.6',
] as const;

export type DocsSourceParam = (typeof docsSourceEnumValues)[number];

export function parseDocsSourceParam(passed: DocsSourceParam): {
  base: DocsBaseSource;
  versionSuffix: string | null;
} {
  if (passed === 'tiger') {
    return { base: 'tiger', versionSuffix: null };
  }
  const i = passed.indexOf('_');
  if (i <= 0) {
    throw new Error('Invalid source');
  }
  const base = passed.slice(0, i) as DocsBaseSource;
  const suffix = passed.slice(i + 1);
  if (base !== 'postgres' && base !== 'postgis') {
    throw new Error('Invalid source');
  }
  if (!suffix) {
    throw new Error('Invalid source');
  }
  return { base, versionSuffix: suffix };
}

export const inputSchema = {
  source: z
    .enum(docsSourceEnumValues)
    .describe(
      'Documentation source with version in the suffix where applicable: tiger; postgres_14 … postgres_18 or postgres_latest; postgis_3.3 … postgis_3.6.',
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
  limit: z.coerce
    .number()
    .int()
    .nullable()
    .describe(
      'The maximum number of matches to return. If omitted, defaults to 10.',
    ),
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

export const outputSchema = {
  results: z.array(z.union([zSemanticResult, zKeywordResult, zHybridResult])),
} as const;
