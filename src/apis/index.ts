import { createViewSkillToolFactory } from '@tigerdata/mcp-boilerplate/skills';
import { parseFeatureFlags } from '../util/featureFlags.js';
import { keywordSearchTigerDocsFactory } from './kewordSearchTigerDocs.js';
import { semanticSearchPostgresDocsFactory } from './semanticSearchPostgresDocs.js';
import { semanticSearchTigerDocsFactory } from './semanticSearchTigerDocs.js';

export const apiFactories = [
  keywordSearchTigerDocsFactory,
  semanticSearchPostgresDocsFactory,
  semanticSearchTigerDocsFactory,
  createViewSkillToolFactory({
    appendSkillsListToDescription: true,
    name: 'view_skill',
    description:
      'Retrieve detailed skills for TimescaleDB operations and best practices.',
    disabled: (_, { query }) => !parseFeatureFlags(query).mcpSkillsEnabled,
  }),
] as const;
