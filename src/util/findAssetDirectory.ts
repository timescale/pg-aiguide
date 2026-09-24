import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** Find a runtime asset using module-relative locations, never process.cwd(). */
export async function findAssetDirectory(
  candidateUrls: readonly URL[],
  assetName: string,
): Promise<string> {
  for (const candidateUrl of candidateUrls) {
    const candidate = fileURLToPath(candidateUrl);
    try {
      if ((await stat(candidate)).isDirectory()) {
        return candidate;
      }
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        continue;
      }
      throw error;
    }
  }

  throw new Error(
    `Could not find ${assetName}; tried ${candidateUrls.map((url) => fileURLToPath(url)).join(', ')}`,
  );
}
