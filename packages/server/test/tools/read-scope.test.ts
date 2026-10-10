import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createFacadeServer, type FacadeServer } from '../../src/http/server.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { CLIPBOARD_UPLOAD_PATH } from '../../src/http/clipboard-upload.js';
import type { RequestIdentity } from '../../src/http/types.js';

const token = 'tm8s_read_scoped_tool_test';
const identity: RequestIdentity = {kind: 'bearer', authKind: 'agent', apiScope: 'read',
  sessionId: randomUUID(), workSessionId: randomUUID(), actorId: randomUUID(), identityId: 'tool-owner'};
const fileUpload = vi.fn(async () => true), clipboardUpload = vi.fn(async () => true);
const upgrade = vi.fn((_req, socket) => { socket.end('HTTP/1.1 101 Switching Protocols\r\n\r\n'); });
let server: FacadeServer, base: string, port: number;
beforeAll(async () => {
  server = createFacadeServer({config: {host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1024},
    registry: new HandlerRegistry(), identityResolver: async headers => {
      expect(headers.authorization).toBe(`Bearer ${token}`);
      return identity;
    }, fileUploadRoute: fileUpload, clipboardUploadRoute: clipboardUpload, upgrades: {handleUpgrade: upgrade}});
  const listening = await server.listen(); base = listening.url; port = listening.port;
});
afterAll(async () => { await server?.close(); });

it('refuses read-scoped tool tokens at the raw PUT upload entry point', async () => {
  const response = await fetch(`${base}/v2/files/uploads/${randomUUID()}/content`, {
    method: 'PUT', headers: {authorization: `Bearer ${token}`}, body: 'file bytes'});
  expect(response.status).toBe(403); expect(fileUpload).not.toHaveBeenCalled();
  expect(await response.text()).toContain('read operations only');
});
it('refuses read-scoped tool tokens at the clipboard POST entry point', async () => {
  const response = await fetch(`${base}${CLIPBOARD_UPLOAD_PATH}`, {
    method: 'POST', headers: {authorization: `Bearer ${token}`}, body: 'image bytes'});
  expect(response.status).toBe(403); expect(clipboardUpload).not.toHaveBeenCalled();
  expect(await response.text()).toContain('read operations only');
});
it('refuses read-scoped tool tokens before terminal WebSocket upgrade/input dispatch', async () => {
  const response = await new Promise<string>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(
      `GET /v2/execution/${identity.workSessionId}/terminal HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${token}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`));
    let data = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('upgrade did not close')); }, 5000);
    socket.on('data', chunk => { data += chunk.toString(); });
    socket.on('close', () => { clearTimeout(timer); resolve(data); }); socket.on('error', reject);
  });
  expect(response).toContain('403'); expect(response).toContain('read operations only');
  expect(upgrade).not.toHaveBeenCalled();
});
