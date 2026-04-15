import { openai } from '@ai-sdk/openai';
import type {
  ApiFactory,
  InferSchema,
  McpFeatureFlags,
} from '@tigerdata/mcp-boilerplate';
import { embed } from 'ai';
import type { z } from 'zod';
import type { ServerContext } from '../../types.js';
import { keywordSearchBySource, semanticSearchBySource } from './queries.js';
import { mergeRrf } from './rrf.js';
import {
  type DocsBaseSource,
  inputSchema,
  latest_pg_version,
  outputSchema,
  parseDocsSourceParam,
} from './schemas.js';

type OutputSchema = InferSchema<typeof outputSchema>;

function versionForQueries(
  base: DocsBaseSource,
  versionSuffix: string | null,
): string | null {
  if (base === 'tiger') {
    return null;
  }
  if (base === 'postgres' && versionSuffix != null) {
    return versionSuffix === 'latest' ? latest_pg_version : versionSuffix;
  }
  if (base === 'postgis') {
    return versionSuffix;
  }
  return null;
}

export const searchDocsFactory: ApiFactory<
  ServerContext,
  typeof inputSchema,
  typeof outputSchema,
  z.infer<(typeof outputSchema)['results']>
> = ({ pgPool, schema }, _featureFlags: McpFeatureFlags) => ({
  name: 'search_docs',
  method: 'get',
  route: '/search-docs',
  config: {
    title: 'Search Documentation',
    description:
      'Search documentation using semantic, keyword, or hybrid (RRF) search. Supports Tiger Cloud (TimescaleDB), PostgreSQL, and PostGIS.',
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

    const { base, versionSuffix } = parseDocsSourceParam(passedSource);
    const version = versionForQueries(base, versionSuffix);

    if (search_type === 'semantic') {
      const { embedding } = await embed({
        model: openai.embedding('text-embedding-3-small'),
        value: query,
      });
      const embeddingJson = JSON.stringify(embedding);
      return {
        results: await semanticSearchBySource(
          base,
          pgPool,
          schema,
          embeddingJson,
          version,
          limit,
        ),
      };
    }

    if (search_type === 'keyword') {
      return {
        results: await keywordSearchBySource(
          base,
          pgPool,
          schema,
          query,
          version,
          limit,
        ),
      };
    }

    if (search_type === 'hybrid') {
      const { embedding } = await embed({
        model: openai.embedding('text-embedding-3-small'),
        value: query,
      });
      const embeddingJson = JSON.stringify(embedding);
      const candLimit = Math.max(limit * 4, 60);
      const [sem, kw] = await Promise.all([
        semanticSearchBySource(
          base,
          pgPool,
          schema,
          embeddingJson,
          version,
          candLimit,
        ),
        keywordSearchBySource(base, pgPool, schema, query, version, candLimit),
      ]);
      return { results: mergeRrf(sem, kw, limit) };
    }

    const _exhaustive: never = search_type;
    throw new Error(`Unsupported search_type: ${_exhaustive}`);
  },
  pickResult: (r) => r.results,
});
