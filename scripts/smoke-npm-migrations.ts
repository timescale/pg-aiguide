import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Test the normal npm executable end to end. It must find packaged migrations
// and run them before MCP starts, even when launched outside the checkout.
// The test image supplies pgvector and pg_textsearch; no docs need ingesting.
const execFileAsync = promisify(execFile);
const projectRoot = join(import.meta.dirname, '..');
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), 'pg-aiguide-migrations-'),
);
const containerName = `pg-aiguide-migrations-${randomUUID()}`;
let containerStarted = false;

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('docker', args);
  return stdout.trim();
}

try {
  const { stdout } = await execFileAsync(
    'npm',
    ['pack', '--json', '--pack-destination', temporaryDirectory],
    { cwd: projectRoot },
  );
  const packages: { filename: string }[] = JSON.parse(stdout);
  assert.equal(packages.length, 1);
  const packageInfo = packages[0];
  assert(packageInfo);
  const tarball = join(temporaryDirectory, packageInfo.filename);
  const installDirectory = join(temporaryDirectory, 'install');
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

  await docker(
    'run',
    '-d',
    '--rm',
    '--name',
    containerName,
    '-e',
    'POSTGRES_PASSWORD=localtest',
    '-p',
    '127.0.0.1::5432',
    'pg-aiguide-migrations-test',
  );
  containerStarted = true;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await docker('exec', containerName, 'pg_isready', '-U', 'postgres');
      ready = true;
      break;
    } catch {
      await sleep(1000);
    }
  }
  assert(ready, 'PostgreSQL test container did not become ready');
  // Match the deployed database setup: extensions live in public so normal
  // search queries can resolve their types and functions without a search_path.
  await docker(
    'exec',
    containerName,
    'psql',
    '-U',
    'postgres',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    'CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_textsearch;',
  );
  const portMapping = await docker('port', containerName, '5432/tcp');
  const pgPort = portMapping.match(/:(\d+)$/m)?.[1];
  assert(pgPort, `Unexpected PostgreSQL port mapping: ${portMapping}`);

  const workingDirectory = join(temporaryDirectory, 'working-directory');
  await mkdir(workingDirectory);
  const installedPackage = join(
    installDirectory,
    'node_modules',
    '@tigerdata',
    'pg-aiguide',
  );
  // Unlike the fast skills smoke test, run the CLI launcher so it cannot pass
  // by skipping the migration step via dist/stdio.js.
  const transport = new StdioClientTransport({
    command: 'node',
    args: [join(installedPackage, 'dist/index.js'), 'stdio'],
    cwd: workingDirectory,
    stderr: 'pipe',
    env: {
      ...process.env,
      PGHOST: '127.0.0.1',
      PGPORT: pgPort,
      PGUSER: 'postgres',
      PGPASSWORD: 'localtest',
      PGDATABASE: 'postgres',
      DB_SCHEMA: 'docs',
    } as Record<string, string>,
  });
  let serverErrors = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    serverErrors += chunk.toString();
  });
  const client = new Client({
    name: 'pg-aiguide-migrations-smoke',
    version: '1.0.0',
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert(tools.some(({ name }) => name === 'view_skill'));
    assert(tools.some(({ name }) => name === 'search_docs'));
    // Keyword-only search avoids an OpenAI key; an empty documentation corpus
    // should still return successfully if the migrations set up the schema.
    const result = await client.callTool({
      name: 'search_docs',
      arguments: {
        source: 'postgres_17',
        query: 'CREATE INDEX',
        limit: 1,
        semanticWeight: 0,
      },
    });
    assert(!result.isError, `search_docs failed: ${JSON.stringify(result)}`);
    const migrationCount = await docker(
      'exec',
      containerName,
      'psql',
      '-U',
      'postgres',
      '-Atqc',
      'SELECT COUNT(*) FROM docs.migrations',
    );
    assert(Number(migrationCount) > 0, 'No migrations were recorded');
    console.log(
      'Packed npm launcher ran migrations and served MCP tools outside the checkout.',
    );
  } catch (error) {
    console.error('MCP server stderr:', serverErrors);
    throw error;
  } finally {
    await client.close();
  }
} finally {
  try {
    if (containerStarted) {
      await docker('rm', '-f', containerName);
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
