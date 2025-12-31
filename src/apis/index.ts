import { keywordSearchPostgisDocsFactory } from './keywordSearchPostgisDocs.js';
import { semanticSearchPostgresDocsFactory } from './semanticSearchPostgresDocs.js';
import { semanticSearchPostgisDocsFactory } from './semanticSearchPostgisDocs.js';
import { semanticSearchTigerDocsFactory } from './semanticSearchTigerDocs.js';
import { viewSkillFactory } from './viewSkill.js';
import { keywordSearchTigerDocsFactory } from './kewordSearchTigerDocs.js';

export const apiFactories = [
  keywordSearchPostgisDocsFactory,
  keywordSearchTigerDocsFactory,
  semanticSearchPostgisDocsFactory,
  semanticSearchPostgresDocsFactory,
  semanticSearchTigerDocsFactory,
  viewSkillFactory,
] as const;
