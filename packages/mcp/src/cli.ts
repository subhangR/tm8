#!/usr/bin/env node
import { HttpCatalogClient } from './catalog-client.js';
import { Tm8McpServer, serveStdio } from './server.js';
import { Tm8ToolRouter } from './tools.js';
import { parseChatMode } from './modes.js';

const baseUrl = process.env.TM8_BASE_URL?.trim() || 'http://127.0.0.1:4610';
const token = process.env.TM8_AGENT_RUNTIME_TOKEN?.trim();

if (!token) {
  process.stderr.write('tm8-mcp: TM8_AGENT_RUNTIME_TOKEN is required\n');
  process.exitCode = 2;
} else {
  const client = new HttpCatalogClient({ baseUrl, token });
  const server = new Tm8McpServer(new Tm8ToolRouter(client, {
    mode: parseChatMode(process.env.TM8_CHAT_MODE),
    ...(process.env.TM8_CHAT_PROJECT_ROOT?.trim()
      ? { projectRoot: process.env.TM8_CHAT_PROJECT_ROOT.trim() }
      : {}),
    ...(process.env.TM8_CHAT_SPACE_ID?.trim()
      ? { spaceId: process.env.TM8_CHAT_SPACE_ID.trim() }
      : {}),
    ...(process.env.TM8_CHAT_HIDDEN_TOOLS?.trim()
      ? { hiddenTools: process.env.TM8_CHAT_HIDDEN_TOOLS.split(',').map((name) => name.trim()).filter(Boolean) }
      : {}),
  }));
  serveStdio(server, { input: process.stdin, output: process.stdout });
}
