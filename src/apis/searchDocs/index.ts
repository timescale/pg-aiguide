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
import { inputSchema, latest_pg_version, outputSchema } from './schemas.js';

type OutputSchema = InferSchema<typeof outputSchema>;

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
      const embeddingJson = JSON.stringify(embedding);
      return {
        results: await semanticSearchBySource(
          source,
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
          source,
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
          source,
          pgPool,
          schema,
          embeddingJson,
          version,
          candLimit,
        ),
        keywordSearchBySource(
          source,
          pgPool,
          schema,
          query,
          version,
          candLimit,
        ),
      ]);
      return { results: mergeRrf(sem, kw, limit) };
    }

    const _exhaustive: never = search_type;
    throw new Error(`Unsupported search_type: ${_exhaustive}`);
  },
  pickResult: (r) => r.results,
});
