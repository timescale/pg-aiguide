import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log, type PromptFactory } from '@tigerdata/mcp-boilerplate';
import matter from 'gray-matter';
import { z } from 'zod';
import type { ServerContext } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Skills directory at repo root level
const skillsDir = join(__dirname, '..', '..', 'skills');

// Allowed subdirectories within a skill directory (one level deep from SKILL.md)
const ALLOWED_SKILL_SUBDIRS = ['scripts', 'references', 'assets'] as const;
const SKILL_MAIN_FILE = 'SKILL.md';

// ===== Skill Types =====

export const zSkillMatter = z.object({
  name: z.string().trim().min(1),
  description: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type SkillMatter = z.infer<typeof zSkillMatter>;

export const zSkill = z.object({
  path: z.string(),
  name: z.string(),
  description: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  availableFiles: z.array(z.string()),
});
export type Skill = z.infer<typeof zSkill>;

// ===== Skill Loading Implementation =====

// Cache for skill content
const skillContentCache: Map<string, string> = new Map();
let skillMapPromise: Promise<Map<string, Skill>> | null = null;

/**
 * Parse a SKILL.md file and validate its metadata
 */
const parseSkillFile = async (
  fileContent: string,
): Promise<{
  matter: SkillMatter;
  content: string;
}> => {
  const { data, content } = matter(fileContent);
  const skillMatter = zSkillMatter.parse(data);

  // Normalize skill name
  if (!/^[a-zA-Z0-9-_]+$/.test(skillMatter.name)) {
    const normalized = skillMatter.name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-_]/g, '_')
      .replace(/-[-_]+/g, '-')
      .replace(/_[_-]+/g, '_')
      .replace(/(^[-_]+)|([-_]+$)/g, '');
    log.warn(
      `Skill name "${skillMatter.name}" contains invalid characters. Normalizing to "${normalized}".`,
    );
    skillMatter.name = normalized;
  }

  return {
    matter: skillMatter,
    content: content.trim(),
  };
};

/**
 * Scan a skill directory for available resource files.
 * Only returns files from allowed subdirectories (scripts/, references/, assets/)
 * and the main SKILL.md file.
 */
async function scanSkillDirectory(skillPath: string): Promise<string[]> {
  const availableFiles: string[] = [SKILL_MAIN_FILE];

  for (const subdir of ALLOWED_SKILL_SUBDIRS) {
    const subdirPath = join(skillPath, subdir);
    try {
      const entries = await readdir(subdirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) {
          // Store relative path from skill root: "scripts/example.sql"
          availableFiles.push(`${subdir}/${entry.name}`);
        }
      }
    } catch {
      // Directory doesn't exist, skip silently
    }
  }

  return availableFiles;
}

/**
 * Validate that a requested path is within allowed boundaries.
 * - Must be SKILL.md OR
 * - Must be within scripts/, references/, or assets/ subdirectories
 * - Path must not contain traversal attacks
 */
function validateSkillPath(
  requestedPath: string,
): { valid: true } | { valid: false; reason: string } {
  // Normalize path to handle various attack vectors
  const normalized = normalize(requestedPath);

  // Block absolute paths
  if (requestedPath.startsWith('/') || requestedPath.includes(':')) {
    return { valid: false, reason: 'Absolute paths not allowed' };
  }

  // Block path traversal attempts
  if (normalized.includes('..')) {
    return { valid: false, reason: 'Path traversal not allowed' };
  }

  // Allow main skill file
  if (normalized === SKILL_MAIN_FILE) {
    return { valid: true };
  }

  // Check if path is within allowed subdirectories
  const parts = normalized.split('/');
  if (parts.length === 2) {
    const subdir = parts[0];
    if (
      ALLOWED_SKILL_SUBDIRS.includes(
        subdir as (typeof ALLOWED_SKILL_SUBDIRS)[number],
      )
    ) {
      return { valid: true };
    }
  }

  return {
    valid: false,
    reason: `Path must be ${SKILL_MAIN_FILE} or within: ${ALLOWED_SKILL_SUBDIRS.join(', ')}`,
  };
}

/**
 * Load all skills from the filesystem
 */
async function doLoadSkills(): Promise<Map<string, Skill>> {
  const skills = new Map<string, Skill>();
  skillContentCache.clear();

  const alreadyExists = (name: string, path: string): boolean => {
    const existing = skills.get(name);
    if (existing) {
      log.warn(
        `Skill with name "${name}" already loaded from path "${existing.path}". Skipping duplicate at path "${path}".`,
      );
      return true;
    }
    return false;
  };

  const loadLocalPath = async (path: string): Promise<void> => {
    const skillPath = join(path, SKILL_MAIN_FILE);
    try {
      const fileContent = await readFile(skillPath, 'utf-8');
      const {
        matter: { name, description, metadata },
        content,
      } = await parseSkillFile(fileContent);

      if (alreadyExists(name, path)) return;

      // Scan for available files in allowed subdirectories
      const availableFiles = await scanSkillDirectory(path);

      skills.set(name, {
        path,
        name,
        description,
        metadata: metadata ?? null,
        availableFiles,
      });

      skillContentCache.set(`${name}/${SKILL_MAIN_FILE}`, content);
    } catch (err) {
      log.error(`Failed to load skill at path: ${skillPath}`, err as Error);
    }
  };

  try {
    // Load skills from subdirectories with SKILL.md files
    const dirEntries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of dirEntries) {
      if (!entry.isDirectory()) continue;
      await loadLocalPath(join(skillsDir, entry.name));
    }

    if (skills.size === 0) {
      log.warn(
        'No skills found. Please add SKILL.md files to the skills/ subdirectories.',
      );
    } else {
      log.info(`Successfully loaded ${skills.size} skill(s)`);
    }
  } catch (err) {
    log.error('Failed to load skills', err as Error);
  }

  return skills;
}

/**
 * Load skills with caching
 */
export const loadSkills = async (
  force = false,
): Promise<Map<string, Skill>> => {
  if (skillMapPromise && !force) {
    return skillMapPromise;
  }

  skillMapPromise = doLoadSkills().catch((err) => {
    log.error('Failed to load skills', err as Error);
    skillMapPromise = null;
    return new Map<string, Skill>();
  });

  return skillMapPromise;
};

/**
 * View skill content
 */
export const viewSkillContent = async (
  name: string,
  targetPath = SKILL_MAIN_FILE,
): Promise<string> => {
  const skillsMap = await loadSkills();
  const skill = skillsMap.get(name);
  if (!skill) {
    throw new Error(`Skill not found: ${name}`);
  }

  // Validate path before accessing
  const validation = validateSkillPath(targetPath);
  if (!validation.valid) {
    throw new Error(`Invalid path '${targetPath}': ${validation.reason}`);
  }

  // Check if requested file exists in available files
  if (!skill.availableFiles.includes(targetPath)) {
    throw new Error(
      `File '${targetPath}' not found in skill '${name}'. ` +
        `Available files: ${skill.availableFiles.join(', ')}`,
    );
  }

  const cacheKey = `${name}/${targetPath}`;
  const cached = skillContentCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // Read from filesystem
  try {
    const fullPath = join(skill.path, targetPath);
    const content = await readFile(fullPath, 'utf-8');
    skillContentCache.set(cacheKey, content);
    return content;
  } catch {
    throw new Error(`Failed to read skill content: ${name}/${targetPath}`);
  }
};

// Initialize skills on module load
export const skills = await loadSkills();

interface PromptResult {
  [x: string]: unknown;
  description: string;
  messages: {
    role: 'user';
    content: {
      type: 'text';
      text: string;
    };
  }[];
}

// Export skills as prompt factories for MCP server
export const promptFactories: PromptFactory<
  ServerContext,
  Record<string, never>
>[] = Array.from(skills.entries()).map(([name, skillData]) => () => ({
  name,
  config: {
    // Using the dash-separated name as the title to work around a problem in Claude Code
    // See https://github.com/anthropics/claude-code/issues/7464
    title: name,
    description: skillData.description,
    inputSchema: {}, // No arguments for static skills
  },
  fn: async (): Promise<PromptResult> => {
    const content = await viewSkillContent(name);
    return {
      description: skillData.description || name,
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: content,
          },
        },
      ],
    };
  },
}));
