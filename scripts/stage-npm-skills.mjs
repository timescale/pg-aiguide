import { copyFile, cp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(projectRoot, 'dist');
const stagedSkillsDir = join(distDir, 'skills');

try {
  // npm pack skips symlinks, so publish regular copies of their targets.
  await rm(stagedSkillsDir, { recursive: true, force: true });
  await cp(join(projectRoot, 'skills'), stagedSkillsDir, {
    recursive: true,
    dereference: true,
  });
  await copyFile(
    join(projectRoot, 'skills.yaml'),
    join(distDir, 'skills.yaml'),
  );
} catch (error) {
  console.error('Failed to stage skills for the npm package:', error);
  process.exitCode = 1;
}
