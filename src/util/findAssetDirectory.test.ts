import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findAssetDirectory } from './findAssetDirectory.js';

test('uses the first existing directory and skips missing paths and files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pg-aiguide-assets-'));
  try {
    const first = join(root, 'missing');
    const file = join(root, 'not-a-directory');
    const preferred = join(root, 'preferred');
    const fallback = join(root, 'fallback');
    await writeFile(file, 'not an asset directory');
    await mkdir(preferred);
    await mkdir(fallback);

    expect(
      await findAssetDirectory(
        [first, file, preferred, fallback].map((path) => pathToFileURL(path)),
        'test assets',
      ),
    ).toBe(preferred);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reports all attempted locations if no directory exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pg-aiguide-assets-'));
  try {
    const candidate = join(root, 'missing');
    await expect(
      findAssetDirectory([pathToFileURL(candidate)], 'test assets'),
    ).rejects.toThrow(`Could not find test assets; tried ${candidate}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
