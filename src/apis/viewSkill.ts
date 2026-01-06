import type { ApiFactory, InferSchema } from '@tigerdata/mcp-boilerplate';
import { z } from 'zod';
import { skills, viewSkillContent } from '../skillutils/index.js';
import type { ServerContext } from '../types.js';
import { parseFeatureFlags } from '../util/featureFlags.js';

// Create enum schema dynamically
const inputSchema = {
  name: z
    .enum(Array.from(skills.keys()) as [string, ...string[]])
    .describe('The name of the skill to retrieve'),
  path: z
    .string()
    .default('SKILL.md')
    .nullable()
    .describe(
      'Optional path to a specific file within the skill. ' +
        'Defaults to SKILL.md (main instructions). ' +
        'Available paths: scripts/<file>, references/<file>, assets/<file>',
    ),
} as const;

const outputSchema = {
  name: z.string().describe('The name of the requested skill'),
  path: z.string().describe('The path within the skill that was retrieved'),
  description: z.string().describe('Description of what this skill does'),
  content: z.string().describe('The file content'),
  availableFiles: z
    .array(z.string())
    .describe(
      'List of available file paths within this skill. ' +
        'Use these paths with the "path" parameter to retrieve additional resources.',
    ),
  metadata: z
    .record(z.string(), z.unknown())
    .nullable()
    .describe('Optional skill metadata (version, author, tags, etc.)'),
} as const;

type OutputSchema = InferSchema<typeof outputSchema>;

export const viewSkillFactory: ApiFactory<
  ServerContext,
  typeof inputSchema,
  typeof outputSchema
> = (_context, { query }) => {
  // Parse feature flags from query or environment
  const flags = parseFeatureFlags(query);

  return {
    name: 'view_skill',
    disabled: !flags.mcpSkillsEnabled,
    config: {
      title: 'View Skill',
      description: `Retrieve detailed skills for TimescaleDB operations and best practices.

**Progressive Disclosure Pattern:**
1. First call: Use default path (SKILL.md) to get main instructions
2. Check \`availableFiles\` in response for additional resources
3. Load specific files on-demand: scripts/, references/, assets/

**Available Skills:**

${Array.from(skills.values())
  .map((s) => `**${s.name}** - ${s.description}`)
  .join('\n\n')}
`,
      inputSchema,
      outputSchema,
    },
    fn: async ({ name, path }): Promise<OutputSchema> => {
      const skill = skills.get(name);

      if (!skill) {
        throw new Error(`Skill '${name}' not found`);
      }

      // Use provided path or default to SKILL.md
      const targetPath = path ?? 'SKILL.md';
      const content = await viewSkillContent(name, targetPath);

      return {
        name: skill.name,
        path: targetPath,
        description: skill.description || '',
        content,
        availableFiles: skill.availableFiles,
        metadata: skill.metadata,
      };
    },
  };
};
