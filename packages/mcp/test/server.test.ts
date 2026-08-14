import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { CatalogTransport } from '../src/catalog-client.js';
import { Tm8McpServer, serveStdio } from '../src/server.js';
import { MCP_TOOL_NAMES, Tm8ToolRouter } from '../src/tools.js';

const transport: CatalogTransport = {
  invoke: async () => ({ ok: true }),
};

function server(): Tm8McpServer {
  return new Tm8McpServer(new Tm8ToolRouter(transport));
}

describe('stdio JSON-RPC server', () => {
  it('negotiates the host protocol and advertises hierarchical instructions', async () => {
    const response = await server().handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    });

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'tm8', version: '0.1.0' },
      },
    });
    expect(JSON.stringify(response)).toContain('mode-gated');
  });

  it('lists the full registry and calls one', async () => {
    const listed = await server().handle({ jsonrpc: '2.0', id: 'list', method: 'tools/list' });
    const tools = (listed as { result: { tools: unknown[] } }).result.tools;
    expect(tools).toHaveLength(MCP_TOOL_NAMES.length);

    const called = await server().handle({
      jsonrpc: '2.0',
      id: 'call',
      method: 'tools/call',
      params: { name: 'tm8_overview', arguments: {} },
    });
    expect(called).toMatchObject({
      id: 'call',
      result: { structuredContent: { schemaVersion: 'tm8.mcp.overview.v1' } },
    });
  });

  it('accepts initialized notifications without writing a response', async () => {
    await expect(
      server().handle({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    ).resolves.toBeNull();
  });

  it('returns the JSON-RPC taxonomy for invalid params and unknown methods', async () => {
    await expect(
      server().handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} }),
    ).resolves.toMatchObject({ error: { code: -32602 } });
    await expect(
      server().handle({ jsonrpc: '2.0', id: 3, method: 'something/else' }),
    ).resolves.toMatchObject({ error: { code: -32601 } });
  });

  it('keeps stdout protocol-only and emits one compact JSON object per line', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    serveStdio(server(), { input, output });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' })}\n`);
    const [chunk] = await once(output, 'data');
    const line = chunk.toString('utf8');

    expect(line.endsWith('\n')).toBe(true);
    expect(line.trim()).toBe('{"jsonrpc":"2.0","id":4,"result":{}}');
    input.end();
    output.end();
  });
});
