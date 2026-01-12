import { createViewSkillToolFactory } from '@tigerdata/mcp-boilerplate/skills';
import { parseFeatureFlags } from '../util/featureFlags.js';
import { searchDocsFactory } from './searchDocs.js';

export const apiFactories = [
  searchDocsFactory,
  createViewSkillToolFactory({
    appendSkillsListToDescription: true,
    name: 'view_skill',
    description:
      'Retrieve detailed skills for TimescaleDB operations and best practices.',
    disabled: (_, { query }) => !parseFeatureFlags(query).mcpSkillsEnabled,
  }),
] as const;
