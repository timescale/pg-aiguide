#!/usr/bin/env node
import { stdioServerFactory } from '@tigerdata/mcp-boilerplate';
import { apiFactories } from './apis/index.js';
import { context, serverInfo } from './serverInfo.js';
import { promptFactories } from './skillutils/index.js';

stdioServerFactory({
  ...serverInfo,
  context,
  apiFactories,
  promptFactories,
});
