#!/usr/bin/env node

/**
 * Validates all SKILL.md files against the Agent Skills spec (https://agentskills.io/specification).
 *
 * Checks:
 * - name: required, 1-64 chars, lowercase alphanumeric + hyphens, no leading/trailing/consecutive hyphens, matches directory name
 * - description: required, 1-1024 chars
 * - SKILL.md body: recommended <500 lines
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const SKILLS_DIR = join(import.meta.dirname, '..', 'skills');
const NAME_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_BODY_LINES = 500;

interface ValidationError {
  skill: string;
  message: string;
  severity: 'error' | 'warning';
}

function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const fm: Record<string, string> = {};
  const raw = match[1];

  // Extract name (single line)
  const nameMatch = raw.match(/^name:\s*(.+)$/m);
  if (nameMatch) fm.name = nameMatch[1].trim();

  // Extract description (may be multi-line with | syntax)
  const descMatch = raw.match(
    /^description:\s*\|?\s*\n([\s\S]*?)(?=\n[a-z][\w-]*:|\n?$)/m,
  );
  if (descMatch) {
    fm.description = descMatch[1].trim();
  } else {
    const singleDescMatch = raw.match(/^description:\s*(.+)$/m);
    if (singleDescMatch) fm.description = singleDescMatch[1].trim();
  }

  return fm;
}

function validateSkill(skillDir: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const dirName = basename(skillDir);
  const skillMdPath = join(skillDir, 'SKILL.md');

  let content: string;
  try {
    content = readFileSync(skillMdPath, 'utf-8');
  } catch {
    errors.push({
      skill: dirName,
      message: 'Missing SKILL.md file',
      severity: 'error',
    });
    return errors;
  }

  const fm = parseFrontmatter(content);
  if (!fm) {
    errors.push({
      skill: dirName,
      message: 'Missing or malformed YAML frontmatter',
      severity: 'error',
    });
    return errors;
  }

  // Validate name
  if (!fm.name) {
    errors.push({
      skill: dirName,
      message: 'Missing required field: name',
      severity: 'error',
    });
  } else {
    if (fm.name.length > MAX_NAME_LENGTH) {
      errors.push({
        skill: dirName,
        message: `name exceeds ${MAX_NAME_LENGTH} chars (${fm.name.length})`,
        severity: 'error',
      });
    }
    if (!NAME_REGEX.test(fm.name)) {
      errors.push({
        skill: dirName,
        message: `name "${fm.name}" must be lowercase alphanumeric with hyphens, no leading/trailing/consecutive hyphens`,
        severity: 'error',
      });
    }
    if (fm.name.includes('--')) {
      errors.push({
        skill: dirName,
        message: `name "${fm.name}" contains consecutive hyphens`,
        severity: 'error',
      });
    }
    if (fm.name !== dirName) {
      errors.push({
        skill: dirName,
        message: `name "${fm.name}" does not match directory name "${dirName}"`,
        severity: 'error',
      });
    }
  }

  // Validate description
  if (!fm.description) {
    errors.push({
      skill: dirName,
      message: 'Missing required field: description',
      severity: 'error',
    });
  } else if (fm.description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push({
      skill: dirName,
      message: `description exceeds ${MAX_DESCRIPTION_LENGTH} chars (${fm.description.length})`,
      severity: 'error',
    });
  }

  // Check body line count
  const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  if (bodyMatch) {
    const bodyLines = bodyMatch[1].split('\n').length;
    if (bodyLines > MAX_BODY_LINES) {
      errors.push({
        skill: dirName,
        message: `SKILL.md body is ${bodyLines} lines (recommended max: ${MAX_BODY_LINES}). Consider splitting into references/`,
        severity: 'warning',
      });
    }
  }

  return errors;
}

// Run validation
const dirs = readdirSync(SKILLS_DIR)
  .map((d) => join(SKILLS_DIR, d))
  .filter((d) => {
    try {
      return statSync(d).isDirectory();
    } catch {
      return false;
    }
  });

let hasErrors = false;
let hasWarnings = false;

for (const dir of dirs) {
  const errors = validateSkill(dir);
  for (const err of errors) {
    const prefix = err.severity === 'error' ? 'ERROR' : 'WARN';
    console.log(`${prefix}: [${err.skill}] ${err.message}`);
    if (err.severity === 'error') hasErrors = true;
    if (err.severity === 'warning') hasWarnings = true;
  }
}

if (!hasErrors && !hasWarnings) {
  console.log(`All ${dirs.length} skills pass spec validation.`);
}

if (hasErrors) {
  process.exit(1);
}
