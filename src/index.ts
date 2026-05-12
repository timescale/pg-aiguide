#!/usr/bin/env node
import 'dotenv/config';

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliEntrypoint } from '@tigerdata/mcp-boilerplate';
import { schema } from './config.js';
import { serverInfo } from './serverInfo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

cliEntrypoint(
  join(__dirname, 'stdio.js'),
  join(__dirname, 'httpServer.js'),
  undefined,
  {
    schema: schema,
    serviceName: serverInfo.name,
  },
).catch(console.error);
