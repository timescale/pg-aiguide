#!/usr/bin/env bun

import semver from 'semver';

interface PackageJson {
  version?: string;
  [key: string]: unknown;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function run(args: Array<string>): Promise<CommandResult> {
  const process = Bun.spawn(args, {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);

  if (exitCode !== 0) {
    const command = args.join(' ');
    fail(stderr.trim() || `Command failed: ${command}`);
  }

  return { stdout, stderr };
}

function validateVersion(version: string): void {
  if (!semver.valid(version)) {
    fail(`Invalid version '${version}'. Expected semver like 0.7.0.`);
  }
}

const nextVersion = process.argv[2];

if (!nextVersion) {
  fail('Usage: ./bun release <version>');
}

validateVersion(nextVersion);

const releaseStatus = await run(['git', 'status', '--porcelain']);
if (releaseStatus.stdout.trim().length > 0) {
  fail(
    'Working directory is not clean. Commit, stash, or discard changes before releasing.',
  );
}

const packageFile = Bun.file('package.json');
if (!(await packageFile.exists())) {
  fail('package.json not found in current directory.');
}

const packageJson = (await packageFile.json()) as PackageJson;
const currentVersion = packageJson.version;

if (!currentVersion || !semver.valid(currentVersion)) {
  fail(
    `Current version '${currentVersion ?? '(missing)'}' in package.json is not valid semver.`,
  );
}

if (!semver.gt(nextVersion, currentVersion)) {
  fail(
    `Version ${nextVersion} is not greater than current version ${currentVersion}.`,
  );
}

const tagName = `v${nextVersion}`;
const tagCheck = await run(['git', 'tag', '-l', tagName]);
if (tagCheck.stdout.trim() === tagName) {
  fail(`Tag ${tagName} already exists.`);
}

await run(['git', 'switch', 'main']);

packageJson.version = nextVersion;
await Bun.write(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`);

const claudeMarketplaceFile = Bun.file('.claude-plugin/marketplace.json');
const claudeMarketplace = await claudeMarketplaceFile.json();
claudeMarketplace.plugins[0].version = nextVersion;
await Bun.write(
  claudeMarketplaceFile,
  `${JSON.stringify(claudeMarketplace, null, 2)}\n`,
);

const cursorPluginFile = Bun.file('.cursor-plugin/plugin.json');
const cursorPlugin = await cursorPluginFile.json();
cursorPlugin.version = nextVersion;
await Bun.write(cursorPluginFile, `${JSON.stringify(cursorPlugin, null, 2)}\n`);

await run([
  'git',
  'add',
  'package.json',
  '.claude-plugin/marketplace.json',
  '.cursor-plugin/plugin.json',
]);
await run(['git', 'commit', '-m', `release: ${tagName}`]);
await run(['git', 'tag', '-a', tagName, '-m', tagName]);
await run(['git', 'push', '--follow-tags']);

console.log(`Released ${tagName}.`);
