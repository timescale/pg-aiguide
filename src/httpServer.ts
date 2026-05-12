#!/usr/bin/env node
import { httpServerFactory } from '@tigerdata/mcp-boilerplate';
import { apiFactories } from './apis/index.js';
import { promptFactories } from './prompts/index.js';
import { context, serverInfo } from './serverInfo.js';

export const { registerCleanupFn } = await httpServerFactory({
  ...serverInfo,
  context,
  apiFactories,
  promptFactories,
  stateful: false,
});
