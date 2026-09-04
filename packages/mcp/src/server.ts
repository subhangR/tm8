/** Dependency-free stdio MCP framing: one JSON-RPC object per line. */
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { Tm8ToolRouter } from './tools.js';

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const MCP_SERVER_INFO = { name: 'tm8', version: '0.1.0' } as const;
export const MCP_PROTOCOL_VERSION = '2025-06-18';

export class Tm8McpServer {
  constructor(private readonly tools: Tm8ToolRouter) {}

  async handle(raw: unknown): Promise<JsonRpcResponse | null> {
    if (!isRequest(raw)) return rpcError(null, -32600, 'Invalid Request');
    const id = raw.id ?? null;
    const notification = raw.id === undefined;
    try {
      switch (raw.method) {
        case 'initialize': {
          if (notification) return null;
          const requested = protocolVersionOf(raw.params);
          return rpcResult(id, {
            protocolVersion: requested ?? MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: MCP_SERVER_INFO,
            instructions:
              'TM8 combines hierarchical graph tools with direct repository, session, docs, web, memory and git tools. Every call is mode-gated.',
          });
        }
        case 'server/discover': {
          if (notification) return null;
          const listed = this.tools.listedTools();
          return rpcResult(id, {
            protocolVersion: '2026-07-28',
            capabilities: { tools: {} },
            serverInfo: MCP_SERVER_INFO,
            tools: { count: listed.length },
          });
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null;
        case 'ping':
          return notification ? null : rpcResult(id, {});
        case 'tools/list':
          return notification ? null : rpcResult(id, { tools: this.tools.listedTools() });
        case 'tools/call': {
          if (notification) return null;
          const params = callParams(raw.params);
          return rpcResult(id, await this.tools.call(params.name, params.arguments));
        }
        default:
          return notification ? null : rpcError(id, -32601, `Method not found: ${raw.method}`);
      }
    } catch (error) {
      return notification
        ? null
        : rpcError(id, -32602, error instanceof Error ? error.message : String(error));
    }
  }
}

export interface StdioServerOptions {
  input: Readable;
  output: Writable;
  maxLineBytes?: number;
}

export function serveStdio(server: Tm8McpServer, options: StdioServerOptions): void {
  const maxLineBytes = options.maxLineBytes ?? 1024 * 1024;
  const lines = createInterface({ input: options.input, crlfDelay: Infinity });
  let queue = Promise.resolve();
  lines.on('line', (line) => {
    queue = queue.then(async () => {
      if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
        write(options.output, rpcError(null, -32600, 'Request exceeds the 1 MiB stdio limit'));
        return;
      }
      let request: unknown;
      try {
        request = JSON.parse(line);
      } catch {
        write(options.output, rpcError(null, -32700, 'Parse error'));
        return;
      }
      const response = await server.handle(request);
      if (response) write(options.output, response);
    }).catch(() => {
      write(options.output, rpcError(null, -32603, 'Internal error'));
    });
  });
}

function isRequest(raw: unknown): raw is JsonRpcRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const value = raw as Record<string, unknown>;
  return value.jsonrpc === '2.0' && typeof value.method === 'string';
}

function protocolVersionOf(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = (raw as Record<string, unknown>).protocolVersion;
  return typeof value === 'string' && value ? value : undefined;
}

function callParams(raw: unknown): { name: string; arguments: unknown } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('tools/call params must be an object');
  const value = raw as Record<string, unknown>;
  if (typeof value.name !== 'string' || value.name === '') throw new Error('tools/call params.name must be a string');
  return { name: value.name, arguments: value.arguments ?? {} };
}

function rpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function write(output: Writable, response: JsonRpcResponse): void {
  output.write(`${JSON.stringify(response)}\n`);
}
