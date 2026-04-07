import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { parseFeatureFlags } from './featureFlags.js';

describe('parseFeatureFlags', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.DISABLE_MCP_SKILLS;
    delete process.env.DISABLE_MCP_SKILLS;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.DISABLE_MCP_SKILLS = originalEnv;
    } else {
      delete process.env.DISABLE_MCP_SKILLS;
    }
  });

  describe('defaults', () => {
    test('returns skills enabled when no query or env var', () => {
      const flags = parseFeatureFlags();
      expect(flags.mcpSkillsEnabled).toBe(true);
    });

    test('returns skills enabled for empty query', () => {
      const flags = parseFeatureFlags({});
      expect(flags.mcpSkillsEnabled).toBe(true);
    });
  });

  describe('query parameters (HTTP transport)', () => {
    test('disables skills when disable_mcp_skills is "1"', () => {
      const flags = parseFeatureFlags({ disable_mcp_skills: '1' });
      expect(flags.mcpSkillsEnabled).toBe(false);
    });

    test('disables skills when disable_mcp_skills is "true"', () => {
      const flags = parseFeatureFlags({ disable_mcp_skills: 'true' });
      expect(flags.mcpSkillsEnabled).toBe(false);
    });

    test('keeps skills enabled for disable_mcp_skills "0"', () => {
      const flags = parseFeatureFlags({ disable_mcp_skills: '0' });
      expect(flags.mcpSkillsEnabled).toBe(true);
    });

    test('keeps skills enabled for disable_mcp_skills "false"', () => {
      const flags = parseFeatureFlags({ disable_mcp_skills: 'false' });
      expect(flags.mcpSkillsEnabled).toBe(true);
    });

    test('keeps skills enabled for unrelated query params', () => {
      const flags = parseFeatureFlags({ other_param: 'value' });
      expect(flags.mcpSkillsEnabled).toBe(true);
    });

    test('query takes precedence over env var', () => {
      process.env.DISABLE_MCP_SKILLS = '1';
      const flags = parseFeatureFlags({ disable_mcp_skills: '0' });
      expect(flags.mcpSkillsEnabled).toBe(true);
    });
  });

  describe('environment variables (stdio transport)', () => {
    test('disables skills when DISABLE_MCP_SKILLS is "1"', () => {
      process.env.DISABLE_MCP_SKILLS = '1';
      const flags = parseFeatureFlags();
      expect(flags.mcpSkillsEnabled).toBe(false);
    });

    test('disables skills when DISABLE_MCP_SKILLS is "true"', () => {
      process.env.DISABLE_MCP_SKILLS = 'true';
      const flags = parseFeatureFlags();
      expect(flags.mcpSkillsEnabled).toBe(false);
    });

    test('keeps skills enabled for DISABLE_MCP_SKILLS "0"', () => {
      process.env.DISABLE_MCP_SKILLS = '0';
      const flags = parseFeatureFlags();
      expect(flags.mcpSkillsEnabled).toBe(true);
    });

    test('keeps skills enabled for DISABLE_MCP_SKILLS "false"', () => {
      process.env.DISABLE_MCP_SKILLS = 'false';
      const flags = parseFeatureFlags();
      expect(flags.mcpSkillsEnabled).toBe(true);
    });

    test('keeps skills enabled for unexpected DISABLE_MCP_SKILLS value', () => {
      process.env.DISABLE_MCP_SKILLS = 'yes';
      const flags = parseFeatureFlags();
      expect(flags.mcpSkillsEnabled).toBe(true);
    });

    test('env var is ignored when query is provided', () => {
      process.env.DISABLE_MCP_SKILLS = '1';
      const flags = parseFeatureFlags({});
      expect(flags.mcpSkillsEnabled).toBe(true);
    });
  });
});
