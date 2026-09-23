import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  createSkillsPromptFactories,
  setSkillConfigReadOverride,
} from '@tigerdata/mcp-boilerplate/skills';

// In a checkout (including Docker) skills/ is at the project root. The npm
// package stages it next to the compiled code under dist/skills/.
const skillDirectoryUrls = [
  new URL('../skills/', import.meta.url),
  new URL('../../skills/', import.meta.url),
];

let skillsDirectory: string | null = null;
for (const skillDirectoryUrl of skillDirectoryUrls) {
  const candidate = fileURLToPath(skillDirectoryUrl);
  try {
    if ((await stat(candidate)).isDirectory()) {
      skillsDirectory = candidate;
      break;
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      continue;
    }
    throw error;
  }
}

if (!skillsDirectory) {
  throw new Error(
    `Could not find the skills directory near ${fileURLToPath(import.meta.url)}`,
  );
}

setSkillConfigReadOverride(async () => ({
  local: { type: 'local_collection', path: skillsDirectory },
}));

export const promptFactories = await createSkillsPromptFactories();
