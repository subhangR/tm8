import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { CONTRACT_VERSION } from '@tm8/contract';
import { run } from '../src/run.js';

interface SeenRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
}

const connection = (baseUrl: string) => ({
  id: '00000000-0000-4000-8000-000000000001',
  name: 'work',
  baseUrl,
  username: 'operator',
  createdAt: '2026-07-29T00:00:00.000Z',
  updatedAt: '2026-07-29T00:00:00.000Z',
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server has no TCP address');
  return `http://127.0.0.1:${address.port}`;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve(text ? JSON.parse(text) as unknown : undefined);
    });
  });
}

describe('named Server connections', () => {
  let registry: Server;
  let remote: Server;
  let registryUrl: string;
  let remoteUrl: string;
  let registrySeen: SeenRequest[] = [];
  let remoteSeen: SeenRequest[] = [];
  let stdout = '';
  let stderr = '';

  beforeAll(async () => {
    remote = createServer(async (req, res) => {
      const body = await readBody(req);
      remoteSeen.push({
        method: req.method ?? '',
        path: new URL(req.url ?? '/', 'http://x').pathname,
        authorization: req.headers.authorization,
        body,
      });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/health') {
        res.end(JSON.stringify({ ok: true, server: 'tm8-server', contractVersion: CONTRACT_VERSION }));
        return;
      }
      res.end(JSON.stringify({ data: { items: [], nextCursor: null }, requestId: 'remote-request' }));
    });
    remoteUrl = await listen(remote);

    registry = createServer(async (req, res) => {
      const body = await readBody(req);
      registrySeen.push({
        method: req.method ?? '',
        path: new URL(req.url ?? '/', 'http://x').pathname,
        authorization: req.headers.authorization,
        body,
      });
      res.setHeader('content-type', 'application/json');
      res.statusCode = req.method === 'POST' ? 201 : 200;
      res.end(JSON.stringify({ data: connection(remoteUrl), requestId: 'registry-request' }));
    });
    registryUrl = await listen(registry);
  });

  afterAll(async () => {
    await Promise.all([
      new Promise<void>((resolve, reject) => registry.close((error) => error ? reject(error) : resolve())),
      new Promise<void>((resolve, reject) => remote.close((error) => error ? reject(error) : resolve())),
    ]);
    delete process.env.TM8_AGENT_TOKEN;
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    registrySeen = [];
    remoteSeen = [];
    stdout = '';
    stderr = '';
    process.env.TM8_BASE_URL = registryUrl;
    process.env.TM8_AGENT_TOKEN = 'server-a-token';
    delete process.env.TM8_CONFIG_PATH;
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    });
  });

  it('resolves --server through A, executes on B, and does not forward A credentials', async () => {
    expect(await run(['--server', 'work', 'space', 'list', '--format', 'json'])).toBe(0);
    expect(registrySeen).toMatchObject([{
      method: 'GET',
      path: '/v2/server-connections/work',
      authorization: 'Bearer server-a-token',
    }]);
    expect(remoteSeen).toMatchObject([{
      method: 'GET',
      path: '/v2/spaces',
      authorization: undefined,
    }]);
    expect(JSON.parse(stdout)).toEqual({ items: [], nextCursor: null });
    expect(stderr).toBe('');
  });

  it('health-checks B before storing the named route on A', async () => {
    expect(await run([
      'server', 'add', 'work', '--url', remoteUrl, '--username', 'operator',
      '--mutation-id', 'mutation-add-work', '--format', 'json',
    ])).toBe(0);
    expect(remoteSeen).toMatchObject([{ method: 'GET', path: '/health' }]);
    expect(registrySeen).toHaveLength(1);
    expect(registrySeen[0]).toMatchObject({
      method: 'POST',
      path: '/v2/server-connections',
      authorization: 'Bearer server-a-token',
      body: {
        name: 'work',
        baseUrl: remoteUrl,
        username: 'operator',
        clientMutationId: 'mutation-add-work',
      },
    });
    expect(JSON.parse(stdout)).toMatchObject({ name: 'work', baseUrl: remoteUrl });
    expect(stderr).toBe('');
  });
});
