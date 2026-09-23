import { cp, rm } from 'node:fs/promises';
import { join } from 'node:path';

const projectRoot = join(import.meta.dirname, '..');
const distDir = join(projectRoot, 'dist');
const stagedSkillsDir = join(distDir, 'skills');

try {
  // npm pack skips symlinks, so publish regular copies of their targets.
  await rm(stagedSkillsDir, { recursive: true, force: true });
  await cp(join(projectRoot, 'skills'), stagedSkillsDir, {
    recursive: true,
    dereference: true,
  });
  // Clean up the old config if dist/ came from a build before the loader used
  // package-relative paths; otherwise npm pack would still publish it.
  await rm(join(distDir, 'skills.yaml'), { force: true });
} catch (error) {
  console.error('Failed to stage skills for the npm package:', error);
  process.exitCode = 1;
}
