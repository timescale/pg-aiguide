#!/usr/bin/env node
import { httpServerFactory } from '@tigerdata/mcp-boilerplate';
import { apiFactories } from './apis/index.js';
import { promptFactories } from './prompts/index.js';
import { context, serverInfo } from './serverInfo.js';

// Enable DNS rebinding protection (Host header allow-list validation) for
// local development only. In production the server is served on arbitrary
// public hostnames where a Host allow-list would reject legitimate traffic,
// and the DNS rebinding threat (a victim's browser reaching an
// unauthenticated localhost server) does not apply.
const isProduction = process.env.NODE_ENV === 'production';

export const { registerCleanupFn } = await httpServerFactory({
  ...serverInfo,
  context,
  apiFactories,
  promptFactories,
  stateful: false,
  dnsRebindingProtection: !isProduction,
});
