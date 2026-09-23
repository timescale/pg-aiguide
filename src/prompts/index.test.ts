import { expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('loads skills and references outside the checkout working directory', async () => {
  const workingDirectory = await mkdtemp(join(tmpdir(), 'pg-aiguide-skills-'));
  try {
    const promptsUrl = new URL('./index.ts', import.meta.url).href;
    const apisUrl = new URL('../apis/index.ts', import.meta.url).href;
    const script = `
      const { promptFactories } = await import(${JSON.stringify(promptsUrl)});
      const { apiFactories } = await import(${JSON.stringify(apisUrl)});
      const viewSkill = await apiFactories[1]({}, { query: {} });
      const main = await viewSkill.fn({ skill_name: 'postgres', path: 'SKILL.md' });
      const reference = await viewSkill.fn({ skill_name: 'postgres', path: 'references/design-postgres-tables.md' });
      console.log(JSON.stringify({
        prompts: promptFactories.length > 0,
        main: main.content.includes('# PostgreSQL Expert Skills'),
        reference: reference.content.includes('# PostgreSQL Table Design'),
      }));
    `;
    const { stdout } = await execFileAsync(process.execPath, ['-e', script], {
      cwd: workingDirectory,
    });
    expect(JSON.parse(stdout)).toEqual({
      prompts: true,
      main: true,
      reference: true,
    });
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
});
