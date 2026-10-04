#!/usr/bin/env node
import { serveConnectorBridge } from './connector-bridge.js';
import { HttpCatalogClient } from './catalog-client.js';
import { Tm8McpServer, serveStdio } from './server.js';
import { Tm8ToolRouter } from './tools.js';
import { routerOptionsFromEnv } from './env.js';

const baseUrl = process.env.TM8_BASE_URL?.trim() || 'http://127.0.0.1:4610';
const token = process.env.TM8_AGENT_RUNTIME_TOKEN?.trim();

const connectorIndex = process.argv.indexOf('--connector');
if (connectorIndex !== -1) {
  serveConnectorBridge(process.argv[connectorIndex + 1] ?? '');
} else if (!token) {
  process.stderr.write('tm8-mcp: TM8_AGENT_RUNTIME_TOKEN is required\n');
  process.exitCode = 2;
} else {
  const client = new HttpCatalogClient({ baseUrl, token });
  // The whole env→options mapping lives in `./env.js` so it can be tested
  // without starting a server; this module body cannot be imported without
  // starting one, which is exactly why the mapping left here went untested.
  const server = new Tm8McpServer(new Tm8ToolRouter(client, routerOptionsFromEnv()));
  serveStdio(server, { input: process.stdin, output: process.stdout });
}
