import {
  createSkillsPromptFactories,
  setSkillConfigReadOverride,
} from '@tigerdata/mcp-boilerplate/skills';
import { findAssetDirectory } from '../util/findAssetDirectory.js';

const skillsDirectory = await findAssetDirectory(
  [
    new URL('../skills/', import.meta.url), // dist/prompts/index.js -> dist/skills (npm)
    new URL('../../skills/', import.meta.url), // src/prompts/index.ts -> skills (checkout/Docker)
  ],
  'skills directory',
);

setSkillConfigReadOverride(async () => ({
  local: { type: 'local_collection', path: skillsDirectory },
}));

export const promptFactories = await createSkillsPromptFactories();
