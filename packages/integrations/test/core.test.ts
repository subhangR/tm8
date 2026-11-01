import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ProviderCatalog, PROVIDERS, mcpHttp, mcpResult } from '../src/index.js';

describe('reusable integration runtime', () => {
  it('accepts reviewed providers without adding enum cases, rejects duplicate identities', () => {
    const first = PROVIDERS[0];
    if (!first) throw new Error('Missing provider fixture');
    const extra = { ...first, id: 'example', endpoint: 'https://example.com/mcp' };
    expect(new ProviderCatalog([...PROVIDERS, extra]).get('example')?.endpoint).toBe(extra.endpoint);
    expect(() => new ProviderCatalog([extra, extra])).toThrow('Duplicate');
    expect(() => new ProviderCatalog([{ ...extra, endpoint: 'https://user:password@example.com/mcp' }])).toThrow('credentials');
  });

  it('performs real HTTP initialize, discovery and a safe read with SSE framing', async () => {
    const received: string[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString());
      received.push(message.method);
      response.setHeader('content-type', 'text/event-stream');
      const result = message.method === 'initialize' ? { protocolVersion: '2025-03-26' }
        : message.method === 'tools/list' ? { tools: [{ name: 'read_status', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: 'ok' }] };
      response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 7, result })}\n\n`);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const url = `http://127.0.0.1:${address.port}/mcp`;
    try {
      await expect(mcpHttp({ url, method: 'POST' })).rejects.toThrow('refused');
      const rpc = async (method: string) => mcpResult(await mcpHttp({ url, method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 7, method }) }, true), 7);
      expect(await rpc('initialize')).toEqual({ protocolVersion: '2025-03-26' });
      expect(await rpc('tools/list')).toMatchObject({ tools: [{ name: 'read_status' }] });
      expect(await rpc('tools/call')).toMatchObject({ content: [{ text: 'ok' }] });
      expect(received).toEqual(['initialize', 'tools/list', 'tools/call']);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('does not confuse another response or error body with a tool result', () => {
    const response = { status: 200, headers: {}, body: JSON.stringify({ jsonrpc: '2.0', id: 8, result: 'other' }) };
    expect(() => mcpResult(response, 7)).toThrow('invalid');
    expect(() => mcpResult({ ...response, body: JSON.stringify({ id: 7, error: { message: 'secret' } }) }, 7)).toThrow('MCP upstream request failed');
  });
});
