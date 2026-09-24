#!/usr/bin/env node
import 'dotenv/config';

import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliEntrypoint } from '@tigerdata/mcp-boilerplate';
import { schema } from './config.js';
import { serverInfo } from './serverInfo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// npm ships migrations beside the compiled entrypoint; source and Docker runs
// keep them at the project root. Never depend on the caller's working directory.
let migrationsDirectory: string | null = null;
for (const candidateUrl of [
  new URL('./migrations/', import.meta.url),
  new URL('../migrations/', import.meta.url),
]) {
  const candidate = fileURLToPath(candidateUrl);
  try {
    if ((await stat(candidate)).isDirectory()) {
      migrationsDirectory = candidate;
      break;
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      continue;
    }
    throw error;
  }
}

if (!migrationsDirectory) {
  throw new Error(`Could not find migrations near ${__dirname}`);
}

cliEntrypoint(
  join(__dirname, 'stdio.js'),
  join(__dirname, 'httpServer.js'),
  undefined,
  {
    schema,
    serviceName: serverInfo.name,
    migrationsDirectory,
  },
).catch(console.error);
