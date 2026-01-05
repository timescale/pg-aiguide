#!/usr/bin/env npx tsx

/**
 * Script to check if upstream skill files have been updated.
 * Reads upstream-skills.json from the project root and compares
 * the pinned content with the current upstream content.
 *
 * Exit codes:
 *   0 - All skills are up to date
 *   1 - One or more skills have upstream changes
 *   2 - Error occurred during check
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'upstream-skills.json');

interface UpstreamConfig {
  source_url: string;
  pinned_commit: string;
  pinned_url: string;
  local_path: string;
  notes?: string;
}

type UpstreamSkillsConfig = Record<string, UpstreamConfig>;

async function fetchContent(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${url}: ${response.status} ${response.statusText}`,
    );
  }
  return response.text();
}

async function checkSkill(
  name: string,
  config: UpstreamConfig,
): Promise<{ name: string; changed: boolean; error?: string }> {
  try {
    // Fetch pinned version
    console.log(`  Fetching pinned version from: ${config.pinned_url}`);
    const pinnedContent = await fetchContent(config.pinned_url);

    // Fetch current version from default branch
    console.log(`  Fetching current version from: ${config.source_url}`);
    const currentContent = await fetchContent(config.source_url);

    if (pinnedContent !== currentContent) {
      return {
        name,
        changed: true,
      };
    }

    return {
      name,
      changed: false,
    };
  } catch (error) {
    return {
      name,
      changed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  console.log('Checking upstream skill files for updates...\n');

  let config: UpstreamSkillsConfig;
  try {
    const configContent = await readFile(CONFIG_PATH, 'utf-8');
    config = JSON.parse(configContent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log('No upstream-skills.json found. Nothing to check.');
      process.exit(0);
    }
    throw error;
  }

  const skillNames = Object.keys(config);
  if (skillNames.length === 0) {
    console.log('No upstream skills configured. Nothing to check.');
    process.exit(0);
  }

  const results: Array<{ name: string; changed: boolean; error?: string }> = [];

  for (const skillName of skillNames) {
    console.log(`Checking skill: ${skillName}`);
    const result = await checkSkill(skillName, config[skillName]);
    results.push(result);
    console.log();
  }

  // Report results
  console.log('=== Results ===\n');

  const errors = results.filter((r) => r.error);
  const changed = results.filter((r) => r.changed && !r.error);
  const upToDate = results.filter((r) => !r.changed && !r.error);

  if (upToDate.length > 0) {
    console.log('Up to date:');
    for (const r of upToDate) {
      console.log(`  - ${r.name}`);
    }
    console.log();
  }

  if (errors.length > 0) {
    console.log('Errors:');
    for (const r of errors) {
      console.log(`  - ${r.name}: ${r.error}`);
    }
    console.log();
  }

  if (changed.length > 0) {
    console.log('UPSTREAM CHANGES DETECTED:');
    for (const r of changed) {
      console.log(`  - ${r.name}`);
    }
    console.log();
    console.log(
      'Please review the upstream changes and update the local skill files if needed.',
    );
    console.log(
      'After updating, update the pinned_commit in upstream-skills.json to the new commit hash.',
    );
    process.exit(1);
  }

  if (errors.length > 0) {
    process.exit(2);
  }

  console.log('All skills are up to date with their upstream sources.');
  process.exit(0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(2);
});
