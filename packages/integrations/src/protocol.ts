import { z } from 'zod';
import type { McpHttpResult } from './transport.js';

const Envelope = z.object({ jsonrpc: z.literal('2.0').optional(), id: z.union([z.number(), z.string()]), result: z.unknown().optional(), error: z.unknown().optional() });

/** Decode a completed JSON or SSE response; never surface provider error bodies. */
export function mcpResult(response: McpHttpResult, id: string | number): unknown {
  if (response.status < 200 || response.status >= 300) throw new Error('MCP upstream request failed');
  const messages = response.headers['content-type']?.includes('text/event-stream')
    ? response.body.split(/\r?\n\r?\n/).map(event => event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')).filter(Boolean)
    : [response.body];
  for (const message of messages) {
    let raw: unknown;
    try { raw = JSON.parse(message); } catch { continue; }
    const value = Envelope.safeParse(raw);
    if (!value.success || value.data.id !== id) continue;
    if (value.data.error !== undefined || value.data.result === undefined) throw new Error('MCP upstream request failed');
    return value.data.result;
  }
  throw new Error('MCP response invalid');
}
