#!/usr/bin/env node
import 'dotenv/config';

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliEntrypoint } from '@tigerdata/mcp-boilerplate';
import { schema } from './config.js';
import { serverInfo } from './serverInfo.js';
import { findAssetDirectory } from './util/findAssetDirectory.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const migrationsDirectory = await findAssetDirectory(
  [
    new URL('./migrations/', import.meta.url), // dist/index.js -> dist/migrations (npm)
    new URL('../migrations/', import.meta.url), // src/index.ts -> migrations (checkout/Docker)
  ],
  'migrations directory',
);

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
