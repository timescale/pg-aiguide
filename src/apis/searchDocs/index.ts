import { openai } from '@ai-sdk/openai';
import type {
  ApiFactory,
  InferSchema,
  McpFeatureFlags,
} from '@tigerdata/mcp-boilerplate';
import { embed } from 'ai';
import type { z } from 'zod';
import type { ServerContext } from '../../types.js';
import { searchKeyword, searchSemantic } from './queries.js';
import { mergeRrf } from './rrf.js';
import { inputSchema, outputSchema, resolveDocsTables } from './schemas.js';

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

    const { entity, version } = resolveDocsTables(passedSource);

    if (search_type === 'semantic') {
      const { embedding } = await embed({
        model: openai.embedding('text-embedding-3-small'),
        value: query,
      });
      return {
        results: await searchSemantic(
          pgPool,
          schema,
          entity,
          JSON.stringify(embedding),
          version,
          limit,
        ),
      };
    }

    if (search_type === 'keyword') {
      return {
        results: await searchKeyword(
          pgPool,
          schema,
          entity,
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
        searchSemantic(
          pgPool,
          schema,
          entity,
          embeddingJson,
          version,
          candLimit,
        ),
        searchKeyword(pgPool, schema, entity, query, version, candLimit),
      ]);
      return { results: mergeRrf(sem, kw, limit) };
    }

    const _exhaustive: never = search_type;
    throw new Error(`Unsupported search_type: ${_exhaustive}`);
  },
  pickResult: (r) => r.results,
});
