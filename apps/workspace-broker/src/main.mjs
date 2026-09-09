import http from 'node:http';
import { mkdir, chmod, chown, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { WorkspaceBroker } from './broker.mjs';
import { WorkspaceCredentials } from './credentials.mjs';
import { WorkspaceExecution } from './execution.mjs';
const broker = new WorkspaceBroker({ machineId: process.env.TM8_MACHINE_ID, image: process.env.TM8_RUNNER_IMAGE, egressContainer: process.env.TM8_EGRESS_CONTAINER });
const credentials = new WorkspaceCredentials(broker);
const socketPath = process.env.TM8_WORKSPACE_BROKER_SOCKET ?? '/run/tm8/workspace-broker.sock';
await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o750 });
await mkdir('/var/lib/tm8-broker', { recursive: true, mode: 0o700 });
const execution = new WorkspaceExecution(broker);
await execution.init();
try { const stat = await lstat(socketPath); if (!stat.isSocket()) throw new Error('Broker path is not a socket'); await unlink(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const server = http.createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  try {
    if (req.method === 'GET' && req.url === '/health') { res.end(JSON.stringify({ data: { ready: true } })); return; }
    if (req.method !== 'POST') throw new Error('method_not_allowed');
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 8 * 1024 * 1024) throw new Error('request_too_large'); chunks.push(chunk); }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    let data;
    if (req.url === '/provision') data = await broker.provision(input);
    else if (req.url === '/operation') data = await broker.operation(input);
    else if (req.url === '/terminal') data = await broker.terminal(input);
    else if (req.url === '/credentials') data = await credentials.request(input);
    else if (req.url === '/execution') data = await execution.request(input);
    else if (req.url === '/terminal/info') {
      const session = broker.session(input.sessionId, input.workspaceId, input.accountId);
      data = { projectId: session.projectId ?? null, credentialProvider: session.credentialProvider ?? null, execution: session.execution === true, spaceId: session.spaceId ?? null };
    }
    else throw new Error('unknown_operation');
    res.end(JSON.stringify({ data }));
  } catch (error) {
    res.statusCode = 409;
    const safe = /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : 'workspace_operation_failed';
    res.end(JSON.stringify({ error: { code: safe, ...(error.detail ? { detail: error.detail } : {}) } }));
  }
});
const ws = new WebSocketServer({ noServer: true, maxPayload: 65536 });
server.on('upgrade', async (req, socket, head) => {
  try {
    const url = new URL(req.url, 'http://broker');
    const match = /^\/terminal\/([a-f0-9-]+)$/.exec(url.pathname);
    if (!match) throw new Error('invalid_terminal');
    const session = broker.session(match[1], url.searchParams.get('workspaceId'), url.searchParams.get('accountId'));
    await broker.requireWorkspace(session.workspaceId, session.accountId);
    ws.handleUpgrade(req, socket, head, client => {
      session.listeners.add(client);
      if (session.execution) {
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const base = session.offset - session.replay.length;
        const start = Number.isSafeInteger(offset) && offset >= 0 && offset <= session.offset ? Math.max(base, offset) : base;
        // Strip historical terminal device queries without decoding UTF-8:
        // their automatic replies must never be injected into a live prompt.
        const replay = Buffer.from(session.replay.subarray(start - base).toString('latin1')
          .replace(/\x1b\[[\x20-\x3f]*[cn]/g, '').replace(/\x1b\[\??\d+;\d+R/g, '').replace(/\x1b\[\?[\x20-\x3f]*u/g, ''), 'latin1');
        client.send(JSON.stringify({ type: 'attached', base: start, gap: Math.max(0, base - offset), next: session.offset, hasReplay: replay.length > 0, epoch: session.id, replayKind: 'delta' }));
        if (replay.length) client.send(replay);
      } else if (session.replay.length) client.send(session.replay);
      if (session.exited) { if (session.execution) client.send(JSON.stringify({ type: 'exit', exitCode: session.exitCode ?? 0 })); client.close(1000); session.listeners.delete(client); return; }
      client.on('message', async (data, binary) => {
        if (binary) return session.socket.write(data);
        try {
          const frame = JSON.parse(data.toString());
          if (frame.type === 'input' && typeof frame.data === 'string') session.socket.write(frame.data);
          else if (frame.type === 'resize' && Number.isInteger(frame.cols) && Number.isInteger(frame.rows) && frame.cols >= 2 && frame.cols <= 500 && frame.rows >= 1 && frame.rows <= 300) {
            await broker.docker.request('POST', `/exec/${session.execId}/resize?h=${frame.rows}&w=${frame.cols}`);
          } else throw new Error('invalid_frame');
        } catch { client.close(1008); }
      });
      client.on('close', () => session.listeners.delete(client));
      client.on('error', () => session.listeners.delete(client));
    });
  } catch { socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); }
});
server.requestTimeout = 150000; server.headersTimeout = 10000;
await new Promise(resolve => server.listen(socketPath, resolve));
await chown(socketPath, 0, Number(process.env.TM8_BROKER_GID ?? 1000)); await chmod(socketPath, 0o660);
await chown(path.dirname(socketPath), 0, Number(process.env.TM8_BROKER_GID ?? 1000));
process.stdout.write('[workspace-broker] Ready on restricted Unix socket\n');
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  ws.close(); for (const session of broker.sessions.values()) session.socket.destroy(); server.close();
});
