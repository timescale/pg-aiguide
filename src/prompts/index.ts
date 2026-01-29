import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSkillsPromptFactories } from '@tigerdata/mcp-boilerplate/skills';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const promptFactories = await createSkillsPromptFactories({
  basePath: join(__dirname, '..', '..'),
});
