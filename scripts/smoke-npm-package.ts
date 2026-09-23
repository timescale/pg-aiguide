import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execFileAsync = promisify(execFile);
const projectRoot = join(import.meta.dirname, '..');
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'pg-aiguide-npm-'));
const installDirectory = join(temporaryDirectory, 'install');
const workingDirectory = join(temporaryDirectory, 'working-directory');

try {
  const { stdout } = await execFileAsync(
    'npm',
    ['pack', '--json', '--pack-destination', temporaryDirectory],
    { cwd: projectRoot },
  );
  const packages: { filename: string }[] = JSON.parse(stdout);
  assert.equal(packages.length, 1, 'npm pack should produce one tarball');
  const packageInfo = packages[0];
  assert(packageInfo);
  const tarball = join(temporaryDirectory, packageInfo.filename);

  await execFileAsync(
    'npm',
    [
      'install',
      '--prefix',
      installDirectory,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--silent',
      tarball,
    ],
    { cwd: temporaryDirectory },
  );

  const installedPackage = join(
    installDirectory,
    'node_modules',
    '@tigerdata',
    'pg-aiguide',
  );
  const installedReference = join(
    installedPackage,
    'dist/skills/postgres/references/design-postgres-tables.md',
  );
  const referenceStats = await lstat(installedReference);
  assert(
    referenceStats.isFile(),
    'the published reference must be a real file',
  );
  assert.equal(
    await readFile(installedReference, 'utf-8'),
    await readFile(
      join(projectRoot, 'skills/design-postgres-tables/SKILL.md'),
      'utf-8',
    ),
    'the published reference must contain the original skill content',
  );

  // The CLI entrypoint runs database migrations before starting MCP; test the
  // stdio server directly until the migration packaging issue is addressed.
  const transport = new StdioClientTransport({
    command: 'node',
    args: [join(installedPackage, 'dist/stdio.js')],
    cwd: workingDirectory,
  });
  const client = new Client({
    name: 'pg-aiguide-npm-smoke',
    version: '1.0.0',
  });
  try {
    await mkdir(workingDirectory);
    await client.connect(transport);

    const { tools } = await client.listTools();
    assert(tools.some(({ name }) => name === 'view_skill'));
    const { prompts } = await client.listPrompts();
    assert(prompts.some(({ name }) => name === 'postgres'));

    const skillChecks: [string, string][] = [
      ['SKILL.md', '# PostgreSQL Expert Skills'],
      ['references/design-postgres-tables.md', '# PostgreSQL Table Design'],
    ];
    for (const [path, expectedText] of skillChecks) {
      const result = await client.callTool({
        name: 'view_skill',
        arguments: { skill_name: 'postgres', path },
      });
      assert(!result.isError, `view_skill failed for ${path}`);
      assert(
        Array.isArray(result.content) &&
          JSON.stringify(result.content).includes(expectedText),
        `view_skill did not return expected content for ${path}`,
      );
    }
    console.log(
      'Packed npm MCP serves skills and nested references outside the checkout.',
    );
  } finally {
    await client.close();
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
