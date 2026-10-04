import { createServer, type Server } from 'node:http';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

// DNS/TLS seams are used only for public-host tests, avoiding internet access.
// Guard, OAuth and transport implementations remain real. Loopback fixtures
// below use real sockets with the explicitly enabled private-network policy.
const seams = vi.hoisted(() => ({
  lookup: vi.fn(),
  https: vi.fn(),
}));
vi.mock('node:dns/promises', () => ({ lookup: seams.lookup }));
vi.mock('node:https', () => ({ request: seams.https }));
import { mcpHttp } from '../src/mcp/transport.js';
import { McpOAuth } from '../src/mcp/oauth.js';

const servers: Server[] = [];
afterEach(async () => {
  vi.clearAllMocks(); seams.lookup.mockReset(); seams.https.mockReset();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});
async function fixture(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
const oauthInput = (origin: string) => ({ identityId: 'human', spaceId: 'space', serverId: 'server', resource: `${origin}/mcp`, issuer: origin, clientId: 'client', allowPrivateNetwork: true });

// Emulate only the socket API while recording the actual pinned lookup supplied
// by mcpHttp. The fallback DNS answer changes to private after the first lookup.
function publicSocket(body = '{}', headers: Record<string, string> = {}, status = 200) {
  const pinned: { address: string; family: number }[] = [];
  seams.https.mockImplementation((_url, options, callback) => {
    const req = new EventEmitter() as EventEmitter & { write: () => void; end: () => void; destroy: () => void };
    req.write = () => {};
    req.destroy = () => req.emit('error', new Error('closed'));
    req.end = () => queueMicrotask(() => {
      options.lookup('provider.test', { all: true }, (_error: null, rows: { address: string; family: number }[]) => pinned.push(...rows));
      const res = new EventEmitter(); Object.assign(res, { statusCode: status, headers }); callback(res);
      res.emit('data', Buffer.from(body)); res.emit('end');
    });
    return req;
  });
  return pinned;
}

describe('independent MCP outbound call-site defenses', () => {
  it.each(['127.0.0.1', '10.1.2.3', '169.254.169.254', '100.64.1.2', '[::1]', '[fd00::1]', '[fe80::1]', '[::ffff:127.0.0.1]'])('refuses private literal %s before opening a socket', async host => {
    await expect(mcpHttp({ url: `https://${host}/mcp`, method: 'GET' })).rejects.toThrow();
    expect(seams.https).not.toHaveBeenCalled(); expect(seams.lookup).not.toHaveBeenCalled();
  });
  it.each([
    [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }],
    [{ address: '2606:4700:4700::1111', family: 6 }, { address: 'fd00::1', family: 6 }],
  ])('rejects mixed public/private DNS answers at the transport call site', async (...addresses) => {
    seams.lookup.mockResolvedValue(addresses);
    await expect(mcpHttp({ url: 'https://provider.test/mcp', method: 'GET' })).rejects.toThrow('private');
    expect(seams.https).not.toHaveBeenCalled(); expect(seams.lookup).toHaveBeenCalledTimes(1);
  });
  it('pins the checked DNS result and never performs a second rebinding lookup', async () => {
    seams.lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]).mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const pinned = publicSocket();
    expect((await mcpHttp({ url: 'https://provider.test/mcp', method: 'GET' })).status).toBe(200);
    expect(pinned).toEqual([{ address: '93.184.216.34', family: 4 }]);
    expect(seams.lookup).toHaveBeenCalledTimes(1);
    expect(seams.https.mock.calls[0]![1].agent).toBe(false);
  });
  it.each(['http://provider.test/mcp', 'https://user:password@provider.test/mcp', 'https://provider.test/mcp#fragment'])('rejects unsafe URL %s before DNS', async url => {
    await expect(mcpHttp({ url, method: 'GET' })).rejects.toThrow('refused');
    expect(seams.lookup).not.toHaveBeenCalled(); expect(seams.https).not.toHaveBeenCalled();
  });
  it('rejects discovery to a private issuer even with an approved public resource', async () => {
    await expect(new McpOAuth('https://tm8.test/callback').begin({ ...oauthInput('https://provider.test'), issuer: 'https://127.0.0.1', allowPrivateNetwork: false })).rejects.toThrow('private');
    expect(seams.https).not.toHaveBeenCalled();
  });
  it('guards advertised protected-resource metadata URLs before fetching them', async () => {
    seams.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    publicSocket('', { 'www-authenticate': 'Bearer resource_metadata="https://169.254.169.254/secrets"' }, 401);
    const { issuer: _issuer, ...input } = oauthInput('https://provider.test');
    await expect(new McpOAuth('https://tm8.test/callback').begin({ ...input, allowPrivateNetwork: false })).rejects.toThrow('private');
    expect(seams.https).toHaveBeenCalledTimes(1);
  });
  it.each(['registration', 'token'])('rechecks DNS at the OAuth %s call site when the issuer rebinds', async stage => {
    const origin = 'https://provider.test';
    seams.lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]).mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    publicSocket(JSON.stringify({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, code_challenge_methods_supported: ['S256'] }));
    const oauth = new McpOAuth('https://tm8.test/callback');
    const input = { ...oauthInput(origin), allowPrivateNetwork: false };
    if (stage === 'registration') {
      await expect(oauth.begin({ ...input, clientId: undefined })).rejects.toThrow('private');
    } else {
      const started = await oauth.begin(input);
      await expect(oauth.callback('human', { state: new URL(started.authorizationUrl).searchParams.get('state')!, code: 'private-code' })).rejects.toThrow('private');
    }
    expect(seams.lookup).toHaveBeenCalledTimes(2);
    expect(seams.https).toHaveBeenCalledTimes(1);
  });
  it.each(['discovery', 'registration', 'token'])('never follows a %s redirect or forwards credentials to its destination', async stage => {
    let destinationRequests = 0; let redirectedRequests = 0; let origin = '';
    const destination = await fixture((_req, res) => { destinationRequests++; res.end('{}'); });
    origin = await fixture((req, res) => {
      const target = stage === 'discovery' ? '/.well-known/oauth-authorization-server' : stage === 'registration' ? '/register' : '/token';
      if (req.url === target) { redirectedRequests++; res.writeHead(307, { location: destination }); res.end(); return; }
      res.end(JSON.stringify({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, code_challenge_methods_supported: ['S256'] }));
    });
    const oauth = new McpOAuth('https://tm8.test/callback');
    if (stage === 'token') {
      const started = await oauth.begin(oauthInput(origin));
      await expect(oauth.callback('human', { state: new URL(started.authorizationUrl).searchParams.get('state')!, code: 'private-code' })).rejects.toThrow('redirect');
    } else {
      await expect(oauth.begin({ ...oauthInput(origin), ...(stage === 'registration' ? { clientId: undefined } : {}) })).rejects.toThrow('redirect');
    }
    expect(redirectedRequests).toBe(1); expect(destinationRequests).toBe(0);
  });
  it('refuses cross-origin dynamic registration without sending a request there', async () => {
    let destinationRequests = 0; let origin = '';
    const destination = await fixture((_req, res) => { destinationRequests++; res.end('{}'); });
    origin = await fixture((_req, res) => res.end(JSON.stringify({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${destination}/register`, code_challenge_methods_supported: ['S256'] })));
    await expect(new McpOAuth('https://tm8.test/callback').begin({ ...oauthInput(origin), clientId: undefined })).rejects.toThrow('registration endpoint');
    expect(destinationRequests).toBe(0);
  });
  it('bounds hostile response size and returns a sanitized transport error', async () => {
    const origin = await fixture((_req, res) => res.end('provider-secret'.repeat(170_000)));
    await expect(mcpHttp({ url: origin, method: 'GET' }, true)).rejects.toThrow(/^MCP endpoint unavailable$/);
  });
});
