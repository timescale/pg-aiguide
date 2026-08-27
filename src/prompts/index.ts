import {
  createSkillsPromptFactories,
  parseSkillsFlags,
  skillVisible,
} from '@tigerdata/mcp-boilerplate/skills';

const skillsPromptFactories = await createSkillsPromptFactories();

// The upstream skills factories only enforce enabled_skills/disabled_skills
// inside the prompt's fn (prompts/get), so a skill hidden via query param was
// still advertised by prompts/list — clients would offer it, then fail with
// "Skill not found" when loading it. Mark hidden skills as disabled so they
// are skipped at registration and never listed for that session.
export const promptFactories = skillsPromptFactories.map(
  (factory): typeof factory =>
    (context, featureFlags) => {
      const prompt = factory(context, featureFlags);
      return {
        ...prompt,
        disabled:
          prompt.disabled ||
          !skillVisible(prompt.name, parseSkillsFlags(featureFlags.query)),
      };
    },
);
