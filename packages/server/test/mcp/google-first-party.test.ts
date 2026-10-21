import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GOOGLE_FIRST_PARTY, googleFirstPartyService, type GoogleFirstPartyService } from '@tm8/contract';
import type { McpOAuthSecret } from '../../src/mcp/credential-store.js';
import { GoogleFirstPartyHost } from '../../src/mcp/first-party/google/host.js';
import { GOOGLE_NOT_CONFIGURED } from '../../src/mcp/first-party/google/endpoints.js';
import { freeSlots } from '../../src/mcp/first-party/google/calendar.js';
import { driveLiteral } from '../../src/mcp/first-party/google/drive.js';
import { McpOAuth } from '../../src/mcp/oauth.js';
import { McpProxy, type McpProxyDefinition } from '../../src/mcp/proxy.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { registerMcpRuntimeHandlers } from '../../src/mcp/handlers.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import type { RequestContext } from '../../src/http/types.js';
import { fixtureKeys, memoryOAuthPending } from './oauth-pending-fixture.js';
import { startGoogleFixture, type GoogleFixture } from './google-fixture.js';

// Every test here runs against the FIXTURE Google (./google-fixture.ts) on a
// loopback port; nothing contacts Google. `privateNetwork` is set on the host
// only, which is the one place a test may point it at loopback HTTP.

let google: GoogleFixture;
beforeEach(async () => { google = await startGoogleFixture(); });
afterEach(async () => { await google.close(); });

const gmail = googleFirstPartyService('google.gmail')!;
const calendar = googleFirstPartyService('google.calendar')!;
const drive = googleFirstPartyService('google.drive')!;

function definition(service: GoogleFirstPartyService, extra: Partial<McpProxyDefinition> = {}): McpProxyDefinition {
  return {
    id: 'server', spaceId: 'space', version: 1, approved: true, enabled: true, transport: 'http', url: service.resource,
    catalogId: service.catalogId, firstParty: true, auth: { type: 'oauth2' }, ...extra,
  };
}

function host(client: () => { clientId: string; clientSecret: string } | undefined = () => google.client) {
  return new GoogleFirstPartyHost({ endpoints: google.endpoints, client, privateNetwork: true });
}

/** A whole connect: begin, the consent redirect (a code from the fixture), callback. */
async function connect(service: GoogleFirstPartyService, googleHost = host()) {
  const pending = memoryOAuthPending();
  const oauth = new McpOAuth('https://tm8.test/mcp/oauth/callback', pending, fixtureKeys());
  const started = await oauth.beginFirstParty({ identityId: 'human' }, { spaceId: 'space', serverId: 'server', definitionVersion: 1, resource: service.resource, label: 'Work Google' },
    googleHost.authorization(definition(service)));
  const authorizationUrl = new URL(started.authorizationUrl);
  const result = await oauth.callback({ identityId: 'human' }, { state: authorizationUrl.searchParams.get('state')!, code: google.issueCode(service.scopes.join(' ')) });
  return { authorizationUrl, pending, result };
}

function proxyFor(service: GoogleFirstPartyService, initial: McpOAuthSecret, extra: Partial<McpProxyDefinition> = {}, googleHost = host()) {
  const state = { secret: initial, replaced: 0 };
  const proxy = new McpProxy({
    authorize: async () => ({ sessionId: 'session', identityId: 'human', spaceId: 'space', serverId: 'server', credentialId: 'account' }),
    definition: async () => definition(service, extra),
    firstParty: value => value.catalogId?.startsWith('google.') ? googleHost : undefined,
    credentials: {
      read: async () => ({ nonce: 'n', secret: state.secret, definitionVersion: 1 }),
      replace: async (_claims, _binding, _nonce, updated) => { state.secret = updated as McpOAuthSecret; state.replaced++; },
    },
  });
  const call = (name: string, args: Record<string, unknown> = {}) => proxy.request({ identityId: 'human' }, 'session', 'server', 'tools/call', { name, arguments: args });
  const list = () => proxy.request({ identityId: 'human' }, 'session', 'server', 'tools/list') as Promise<{ tools: { name: string; inputSchema: Record<string, unknown> }[] }>;
  return { proxy, state, call, list };
}

/** The JSON a successful tool call returned. */
function data(result: unknown): Record<string, any> {
  const value = result as { isError?: boolean; content: { type: string; text: string }[] };
  expect(value.isError).toBeUndefined();
  return JSON.parse(value.content[0]!.text) as Record<string, any>;
}

describe('Google OAuth begin (§8.1): static endpoints, offline access, consent, incremental scopes', () => {
  it('sends the person to Google\'s own authorization endpoint with PKCE and the service\'s minimum scopes, and no RFC 8707 resource', async () => {
    const { authorizationUrl } = await connect(gmail);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(google.endpoints.authorization);
    const params = Object.fromEntries(authorizationUrl.searchParams);
    expect(params).toMatchObject({
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',
      response_type: 'code', client_id: google.client.clientId, redirect_uri: 'https://tm8.test/mcp/oauth/callback', code_challenge_method: 'S256',
      scope: 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose',
    });
    expect(params.resource).toBeUndefined();
    expect(params.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('Drive asks for drive.file only, never the whole Drive; Calendar for events and read-only calendars', async () => {
    expect((await connect(drive)).authorizationUrl.searchParams.get('scope')).toBe('openid email https://www.googleapis.com/auth/drive.file');
    expect((await connect(calendar)).authorizationUrl.searchParams.get('scope')).toBe('openid email https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events');
  });

  it('seals the pending sign-in: the stored row holds only the state hash, never the client secret or the verifier', async () => {
    const pending = memoryOAuthPending();
    const oauth = new McpOAuth('https://tm8.test/mcp/oauth/callback', pending, fixtureKeys());
    const started = await oauth.beginFirstParty({ identityId: 'human' }, { spaceId: 'space', serverId: 'server', resource: gmail.resource }, host().authorization(definition(gmail)));
    const state = new URL(started.authorizationUrl).searchParams.get('state')!;
    const [key, row] = [...pending.rows.entries()][0]!;
    expect(key).toBe(createHash('sha256').update(state).digest('hex'));
    for (const secret of [state, google.client.clientSecret, google.endpoints.token]) expect(JSON.stringify(row)).not.toContain(secret);
  });

  it('a provider parameter can never replace the state, the PKCE challenge, the client or the redirect', async () => {
    const pending = memoryOAuthPending();
    const oauth = new McpOAuth('https://tm8.test/mcp/oauth/callback', pending, fixtureKeys());
    const provider = host().authorization(definition(gmail));
    const hostile = { ...provider, authorizeParams: { ...provider.authorizeParams, state: 'attacker', client_id: 'attacker', redirect_uri: 'https://evil.example.test/', code_challenge: 'attacker' } };
    const url = new URL((await oauth.beginFirstParty({ identityId: 'human' }, { spaceId: 'space', serverId: 'server', resource: gmail.resource }, hostile)).authorizationUrl);
    expect(url.searchParams.get('client_id')).toBe(google.client.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe('https://tm8.test/mcp/oauth/callback');
    expect(url.searchParams.get('state')).not.toBe('attacker');
    expect(url.searchParams.get('code_challenge')).not.toBe('attacker');
    expect(createHash('sha256').update(url.searchParams.get('state')!).digest('hex')).toBe([...pending.rows.keys()][0]);
  });

  it('refuses to begin when this node has no Google client configured', () => {
    expect(() => host(() => undefined).authorization(definition(gmail))).toThrow(GOOGLE_NOT_CONFIGURED);
  });

  it('refuses a definition whose URL is not the service\'s own, or that is not first-party', () => {
    expect(() => host().authorization(definition(gmail, { url: 'https://evil.example.test/gmail' }))).toThrow('unavailable');
    expect(() => host().authorization(definition(gmail, { catalogId: 'google.photos' }))).toThrow('unavailable');
    expect(() => host().authorization(definition(gmail, { firstParty: false }))).toThrow('unavailable');
  });
});

describe('Google OAuth callback', () => {
  it('exchanges the code with the configured client (client_secret_post), sends no resource, and keeps the client secret out of the connection', async () => {
    const { authorizationUrl, result } = await connect(gmail);
    const [token] = google.calls('/token');
    const form = Object.fromEntries(new URLSearchParams(token!.body));
    expect(form).toMatchObject({ grant_type: 'authorization_code', client_id: google.client.clientId, client_secret: google.client.clientSecret, redirect_uri: 'https://tm8.test/mcp/oauth/callback' });
    expect(form.resource).toBeUndefined();
    expect(createHash('sha256').update(form.code_verifier!).digest('base64url')).toBe(authorizationUrl.searchParams.get('code_challenge'));
    expect(result.grantedScopes).toEqual([...gmail.scopes]);
    expect(result.secret).toMatchObject({
      kind: 'oauth', accessToken: google.accessToken, refreshToken: google.refreshToken,
      issuer: 'https://accounts.google.com', tokenEndpoint: google.endpoints.token, revocationEndpoint: google.endpoints.revocation,
      resource: gmail.resource, clientId: google.client.clientId,
    });
    expect(result.secret.clientSecret).toBeUndefined();
    expect(JSON.stringify(result.secret)).not.toContain(google.client.clientSecret);
  });

  it('labels the connection with the Google account\'s address from userinfo, and connects unlabelled if userinfo fails', async () => {
    const { result } = await connect(gmail);
    expect(await host().accountLabel(result.secret.accessToken)).toBe(google.email);
    google.failUserinfo = true;
    expect(await host().accountLabel(result.secret.accessToken)).toBeUndefined();
  });
});

describe('the handlers: mcp.oauth.begin / callback / revoke on a first-party connector', () => {
  const serverId = '00000000-0000-4000-8000-0000000000aa';
  function handlers(configured = true) {
    const rpcs: { fn: string; args: unknown[] }[] = [];
    const db = {
      rpc: async (_claims: unknown, fn: string, args: unknown[]) => {
        rpcs.push({ fn, args });
        if (fn === 'create_mcp_credential') return { id: args[0] };
        if (fn === 'list_mcp_credentials') return [{ id: 'cred', serverId, label: 'Work Google', authType: 'oauth2', manageable: true, ownerId: 'human' }];
        throw new Error(`unexpected rpc ${fn}`);
      },
    };
    const registry = new HandlerRegistry();
    const deps = { db, owner: async () => ({ identityId: 'human', isNodeAdmin: false }) } as unknown as FacadeDeps;
    registerMcpRuntimeHandlers(registry, deps, {
      dataDir: '/unused-google-fixture', callbackUrl: 'https://tm8.test/mcp/oauth/callback', oauthPending: memoryOAuthPending(), keys: fixtureKeys(),
      google: { endpoints: google.endpoints, client: () => configured ? google.client : undefined, privateNetwork: true },
      definition: async () => ({ id: serverId, spaceId: 'space', version: 3, securityRevision: 3, definition: { ...definition(gmail), name: 'gmail', envKeys: [], headerKeys: [] } }) as never,
      authorize: async () => { throw new Error('unused'); },
    });
    const ctx = (body: unknown, params: Record<string, string> = { serverId }) => ({ body, params, identity: { kind: 'bearer', identityId: 'human', authKind: 'browser' }, requestId: 'fixture' }) as RequestContext;
    return { registry, rpcs, ctx };
  }

  it('connects a Google account end to end and stores its account label and granted scopes', async () => {
    const { registry, rpcs, ctx } = handlers();
    const started = await registry.get('mcp.oauth.begin')!(ctx({ clientMutationId: 'begin', label: 'Work Google' })) as { authorizationUrl: string };
    const authorizationUrl = new URL(started.authorizationUrl);
    expect(authorizationUrl.searchParams.get('access_type')).toBe('offline');
    expect(google.requests).toHaveLength(0); // no discovery: Google's endpoints are static
    await registry.get('mcp.oauth.callback')!(ctx({ state: authorizationUrl.searchParams.get('state'), code: google.issueCode(gmail.scopes.join(' ')) }));
    const create = rpcs.find(call => call.fn === 'create_mcp_credential')!;
    // [.., label, ciphertext, nonce, kind, expiresAt, refreshable, expectedRevision, scope, keyId, accountLabel, grantedScopes]
    expect(create.args[3]).toBe('Work Google');
    expect(create.args[6]).toBe('token');
    expect(create.args[8]).toBe(true);
    expect(create.args[9]).toBe(3);
    expect(create.args[12]).toBe(google.email);
    expect(create.args[13]).toEqual([...gmail.scopes]);
    expect(google.calls('/userinfo')).toHaveLength(1);
  });

  it('refuses begin with the env vars to set when the node has no Google client', async () => {
    const { registry, ctx } = handlers(false);
    await expect(registry.get('mcp.oauth.begin')!(ctx({ clientMutationId: 'begin', label: 'x' }))).rejects.toThrow('TM8_GOOGLE_OAUTH_CLIENT_ID');
  });
});

describe('the proxy calls the host in-process', () => {
  it('lists each service\'s tools with JSON schemas, never relays to the definition URL, and does no MCP handshake', async () => {
    const expected: Record<string, string[]> = {
      'google.gmail': ['search_messages', 'get_message', 'get_thread', 'list_labels', 'create_draft'],
      'google.calendar': ['list_calendars', 'list_events', 'get_event', 'create_event', 'update_event', 'find_free_time'],
      'google.drive': ['search_files', 'get_file', 'export_doc', 'create_file'],
    };
    for (const service of GOOGLE_FIRST_PARTY) {
      const { result } = await connect(service);
      const { tools } = await proxyFor(service, result.secret).list();
      expect(tools.map(tool => tool.name)).toEqual(expected[service.catalogId]);
      for (const tool of tools) expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    }
    // The connects' code exchanges are all the fixture saw: a tools/list is answered in-process.
    expect(google.requests.every(request => request.path === '/token')).toBe(true);
  });

  it('Gmail: search, read a message and a thread, list labels, and create a draft', async () => {
    const { result } = await connect(gmail);
    const { call } = proxyFor(gmail, result.secret);
    const searched = data(await call('search_messages', { query: 'from:alice', maxResults: 5 }));
    expect(searched.messages).toEqual([expect.objectContaining({ id: 'msg-1', threadId: 'thread-1', from: 'Alice <alice@example.test>', subject: 'Lunch', snippet: 'Lunch on Friday?' })]);
    expect(google.calls('/gmail/v1/users/me/messages')[0]!.query.get('q')).toBe('from:alice');
    expect(google.calls('/gmail/v1/users/me/messages/msg-1')[0]!.query.getAll('metadataHeaders')).toEqual(['From', 'To', 'Cc', 'Subject', 'Date']);

    const message = data(await call('get_message', { id: 'msg-1' }));
    expect(message).toMatchObject({ id: 'msg-1', body: 'Lunch on Friday at noon?', messageIdHeader: '<lunch@example.test>', attachments: [{ filename: 'menu.pdf', attachmentId: 'att-1' }] });
    expect(data(await call('get_thread', { id: 'thread-1' })).messages).toHaveLength(1);
    expect(data(await call('list_labels')).labels).toEqual([{ id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'Label_1', name: 'Receipts', type: 'user' }]);

    const draft = data(await call('create_draft', { to: ['bob@example.test'], subject: 'Grüße', body: 'See you Friday.', threadId: 'thread-1', inReplyTo: '<lunch@example.test>' }));
    expect(draft).toEqual({ draftId: 'draft-1', messageId: 'msg-draft-1', threadId: 'thread-1' });
    const raw = google.drafts[0]!;
    expect(raw).toContain('To: bob@example.test\r\n');
    expect(raw).toContain(`Subject: =?UTF-8?B?${Buffer.from('Grüße').toString('base64')}?=`);
    expect(raw).toContain('In-Reply-To: <lunch@example.test>');
    expect(Buffer.from(raw.split('\r\n\r\n')[1]!.replace(/\r\n/g, ''), 'base64').toString()).toBe('See you Friday.');
    expect(google.sent).toHaveLength(0);
    // Every REST call carried the connection's own token.
    expect(google.requests.filter(request => request.path.startsWith('/gmail/')).every(request => request.authorization === `Bearer ${result.secret.accessToken}`)).toBe(true);
  });

  it('Gmail refuses a header injection and reports a Google error as a tool error, not a crash', async () => {
    const { result } = await connect(gmail);
    const { call } = proxyFor(gmail, result.secret);
    const injected = await call('create_draft', { to: ['bob@example.test'], subject: 'hi\r\nBcc: everyone@example.test', body: 'x' }) as { isError: boolean; content: { text: string }[] };
    expect(injected.isError).toBe(true);
    expect(injected.content[0]!.text).toContain('subject');
    expect(google.drafts).toHaveLength(0);
    const missing = await call('get_message', { id: 'nope' }) as { isError: boolean; content: { text: string }[] };
    expect(missing).toEqual({ isError: true, content: [{ type: 'text', text: 'Google API error 404: Requested entity was not found.' }] });
  });

  it('Calendar: list calendars and events, read, create and update an event, and find free time', async () => {
    const { result } = await connect(calendar);
    const { call } = proxyFor(calendar, result.secret);
    expect(data(await call('list_calendars')).calendars).toEqual([{ id: 'primary-id', summary: 'Fixture User', primary: true, accessRole: 'owner', timeZone: 'UTC' }]);
    const listed = data(await call('list_events', { timeMin: '2026-10-21T00:00:00Z', timeMax: '2026-10-22T00:00:00Z' }));
    expect(listed.events).toEqual([expect.objectContaining({ id: 'evt-1', summary: 'Standup', attendees: [{ email: 'bob@example.test', responseStatus: 'accepted' }] })]);
    expect(Object.fromEntries(google.calls('/calendar/v3/calendars/primary/events')[0]!.query)).toMatchObject({ singleEvents: 'true', orderBy: 'startTime', timeMin: '2026-10-21T00:00:00Z', maxResults: '25' });
    expect(data(await call('get_event', { eventId: 'evt-1' }))).toMatchObject({ id: 'evt-1', organizer: 'fixture.user@example.test' });

    const created = data(await call('create_event', { summary: 'Review', start: '2026-10-22T14:00:00', end: '2026-10-22T15:00:00', timeZone: 'Europe/Berlin', attendees: ['carol@example.test'] }));
    expect(created).toMatchObject({ id: 'evt-new', summary: 'Review' });
    const createRequest = google.calls('/calendar/v3/calendars/primary/events').find(request => request.method === 'POST')!;
    expect(createRequest.query.get('sendUpdates')).toBe('none');
    expect(JSON.parse(createRequest.body)).toEqual({ summary: 'Review', start: { dateTime: '2026-10-22T14:00:00', timeZone: 'Europe/Berlin' }, end: { dateTime: '2026-10-22T15:00:00', timeZone: 'Europe/Berlin' }, attendees: [{ email: 'carol@example.test' }] });
    // An all-day event is a date, not a date-time.
    await call('create_event', { summary: 'Offsite', start: '2026-10-23', end: '2026-10-24' });
    expect(JSON.parse(google.calls('/calendar/v3/calendars/primary/events').filter(request => request.method === 'POST')[1]!.body)).toMatchObject({ start: { date: '2026-10-23' }, end: { date: '2026-10-24' } });

    expect(data(await call('update_event', { eventId: 'evt-1', summary: 'Standup (moved)' }))).toMatchObject({ id: 'evt-1', summary: 'Standup (moved)' });
    const patch = google.calls('/calendar/v3/calendars/primary/events/evt-1').find(request => request.method === 'PATCH')!;
    expect(JSON.parse(patch.body)).toEqual({ summary: 'Standup (moved)' });

    const free = data(await call('find_free_time', { timeMin: '2026-10-21T08:00:00Z', timeMax: '2026-10-21T12:00:00Z', durationMinutes: 45 }));
    expect(free.free).toEqual([{ start: '2026-10-21T08:00:00.000Z', end: '2026-10-21T09:00:00.000Z' }, { start: '2026-10-21T10:00:00.000Z', end: '2026-10-21T12:00:00.000Z' }]);
    expect(JSON.parse(google.calls('/calendar/v3/freeBusy')[0]!.body)).toEqual({ timeMin: '2026-10-21T08:00:00Z', timeMax: '2026-10-21T12:00:00Z', items: [{ id: 'primary' }] });
  });

  it('Drive: search, read a text file, export a Doc, and create a file — all on drive.file', async () => {
    const { result } = await connect(drive);
    const { call } = proxyFor(drive, result.secret);
    const searched = data(await call('search_files', { query: "Q3 'plan'" }));
    expect(searched.files.map((file: { id: string }) => file.id)).toEqual(['file-txt', 'file-doc']);
    expect(google.calls('/drive/v3/files')[0]!.query.get('q')).toBe("trashed = false and fullText contains 'Q3 \\'plan\\''");
    expect(data(await call('get_file', { fileId: 'file-txt' }))).toMatchObject({ id: 'file-txt', name: 'notes.txt', content: 'hello drive' });
    expect(data(await call('get_file', { fileId: 'file-doc' }))).toMatchObject({ id: 'file-doc', content: null });
    expect(data(await call('export_doc', { fileId: 'file-doc', mimeType: 'text/markdown' }))).toEqual({ fileId: 'file-doc', mimeType: 'text/markdown', content: '# Plan\n\nShip it.' });
    const created = data(await call('create_file', { name: 'summary.md', content: '# Summary', mimeType: 'text/markdown', convertToGoogleDoc: true, parentId: 'folder-1' }));
    expect(created).toMatchObject({ id: 'file-new', name: 'summary.md', mimeType: 'application/vnd.google-apps.document', parents: ['folder-1'] });
    const upload = google.calls('/upload/drive/v3/files')[0]!;
    expect(upload.query.get('uploadType')).toBe('multipart');
    expect(upload.contentType).toMatch(/^multipart\/related; boundary=tm8-[0-9a-f]{24}$/);
    expect(upload.body).toContain('Content-Type: text/markdown; charset=UTF-8\r\n\r\n# Summary\r\n');
  });
});

describe('the Gmail send gate (§8.2, Q7): closed unless an admin turns it on', () => {
  it.each([
    ['absent', undefined],
    ['false', { gmailSend: false }],
    ['another gate open', { gmailRead: true }],
  ])('gate %s: send_message is not listed, and calling it by name is refused before anything reaches Google', async (_label, gates) => {
    const { result } = await connect(gmail);
    const { call, list } = proxyFor(gmail, result.secret, gates ? { gates } : {});
    expect((await list()).tools.map(tool => tool.name)).not.toContain('send_message');
    const before = google.requests.length;
    await expect(call('send_message', { to: ['bob@example.test'], subject: 'hi', body: 'x' })).rejects.toThrow('send_message is turned off');
    expect(google.requests).toHaveLength(before);
    expect(google.sent).toHaveLength(0);
  });

  it('gate true: send_message is listed and sends', async () => {
    const { result } = await connect(gmail);
    const { call, list } = proxyFor(gmail, result.secret, { gates: { gmailSend: true } });
    expect((await list()).tools.map(tool => tool.name)).toContain('send_message');
    expect(data(await call('send_message', { to: ['bob@example.test'], subject: 'hi', body: 'Sent from tm8.' }))).toEqual({ messageId: 'msg-sent-1', threadId: 'thread-sent' });
    expect(google.sent).toHaveLength(1);
    expect(google.sent[0]).toContain('To: bob@example.test');
  });

  it('an unknown tool is refused, not forwarded', async () => {
    const { result } = await connect(gmail);
    const before = google.requests.length;
    await expect(proxyFor(gmail, result.secret).call('delete_everything')).rejects.toThrow('MCP tool unavailable');
    expect(google.requests).toHaveLength(before);
  });
});

describe('refresh', () => {
  it('refreshes an expiring token with the configured client secret and no resource, keeps Google\'s refresh token, and uses the new access token', async () => {
    const { result } = await connect(gmail);
    const refreshToken = result.secret.refreshToken;
    const { call, state } = proxyFor(gmail, { ...result.secret, expiresAt: Date.now() + 5_000 });
    data(await call('list_labels'));
    const refresh = google.calls('/token').at(-1)!;
    expect(Object.fromEntries(new URLSearchParams(refresh.body))).toEqual({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: google.client.clientId, client_secret: google.client.clientSecret });
    expect(state.replaced).toBe(1);
    expect(state.secret).toMatchObject({ accessToken: google.accessToken, refreshToken });
    expect(state.secret.accessToken).not.toBe(result.secret.accessToken);
    expect(state.secret.clientSecret).toBeUndefined();
    expect(google.calls('/gmail/v1/users/me/labels')[0]!.authorization).toBe(`Bearer ${google.accessToken}`);
  });

  it('a 401 from Google refreshes once and retries the call', async () => {
    const { result } = await connect(calendar);
    const { call, state } = proxyFor(calendar, result.secret);
    google.expireAccess();
    expect(data(await call('list_calendars')).calendars).toHaveLength(1);
    expect(state.replaced).toBe(1);
    expect(google.calls('/calendar/v3/users/me/calendarList').map(request => request.authorization)).toEqual([`Bearer ${result.secret.accessToken}`, `Bearer ${state.secret.accessToken}`]);
  });

  it('a revoked grant fails the call after one refresh attempt, and does not loop', async () => {
    const { result } = await connect(drive);
    const { call } = proxyFor(drive, result.secret);
    google.expireAccess(); google.revokeRefresh();
    const before = google.calls('/token').length;
    await expect(call('search_files')).rejects.toThrow('OAuth token exchange failed');
    expect(google.calls('/token')).toHaveLength(before + 1);
    expect(google.calls('/drive/v3/files')).toHaveLength(1);
  });

  it('refuses to refresh a connection bound to another token endpoint, or when the node lost its client', async () => {
    const { result } = await connect(gmail);
    await expect(host().refresh({ ...result.secret, tokenEndpoint: 'https://evil.example.test/token' })).rejects.toThrow('binding mismatch');
    await expect(host(() => undefined).refresh(result.secret)).rejects.toThrow(GOOGLE_NOT_CONFIGURED);
    await expect(host(() => ({ clientId: 'other-client', clientSecret: 's' })).refresh(result.secret)).rejects.toThrow('reconnect');
  });
});

describe('scope containment (B39): each connector reaches only its own Google API', () => {
  it('a Calendar connection whose token also carries the Gmail scope cannot reach Gmail through tm8', async () => {
    // One grant: Gmail first, then Calendar with include_granted_scopes — the
    // Calendar token is good for Gmail too, as far as Google is concerned.
    const { result } = await connect(calendar);
    const { call } = proxyFor(calendar, result.secret);
    for (const name of ['search_messages', 'get_message', 'create_draft', 'send_message', 'search_files', 'create_file']) {
      await expect(call(name, {})).rejects.toThrow('MCP tool unavailable');
    }
    for (const name of ['list_calendars', 'list_events', 'find_free_time']) {
      await call(name, name === 'find_free_time' ? { timeMin: '2026-10-21T08:00:00Z', timeMax: '2026-10-21T12:00:00Z' } : {});
    }
    // And below the tool table: the client the host hands Calendar tools refuses another API's base.
    const api = host().api(definition(calendar), result.secret.accessToken);
    await expect(api.json('GET', google.endpoints.gmail, '/users/me/labels')).rejects.toThrow('may not call this Google API');
    await expect(api.json('GET', google.endpoints.drive, '/files')).rejects.toThrow('may not call this Google API');
    expect(google.requests.filter(request => request.path !== '/token').every(request => request.path.startsWith('/calendar/'))).toBe(true);
  });

  it('Drive may use its upload base; Gmail may not', async () => {
    const { result } = await connect(gmail);
    await expect(host().api(definition(gmail), result.secret.accessToken).raw('POST', google.endpoints.driveUpload, '/files', {}, 'text/plain', 'x')).rejects.toThrow('may not call this Google API');
    expect(google.calls('/upload/drive/v3/files')).toHaveLength(0);
  });
});

describe('what the proxy refuses on a first-party definition', () => {
  it('a definition whose URL is not the service\'s own is unavailable, and nothing reaches Google', async () => {
    const { result } = await connect(gmail);
    const before = google.requests.length;
    await expect(proxyFor(gmail, { ...result.secret, resource: 'https://evil.example.test/gmail' }, { url: 'https://evil.example.test/gmail' }).list()).rejects.toThrow('unavailable');
    expect(google.requests).toHaveLength(before);
  });

  it('a first-party definition this node has no host for is unavailable', async () => {
    const { result } = await connect(gmail);
    const proxy = new McpProxy({
      authorize: async () => ({ sessionId: 's', identityId: 'human', spaceId: 'space', serverId: 'server', credentialId: 'account' }),
      definition: async () => definition(gmail),
      credentials: { read: async () => ({ nonce: 'n', secret: result.secret }), replace: async () => {} },
    });
    await expect(proxy.request({ identityId: 'human' }, 's', 'server', 'tools/list')).rejects.toThrow('unavailable');
  });

  it('a connection bound to another service\'s resource is a binding mismatch', async () => {
    const { result } = await connect(drive);
    await expect(proxyFor(gmail, result.secret).list()).rejects.toThrow('binding mismatch');
  });
});

describe('helpers', () => {
  it('freeSlots merges overlapping busy blocks and drops gaps shorter than the duration', () => {
    const at = (time: string) => Date.parse(`2026-10-21T${time}:00Z`);
    expect(freeSlots(at('08:00'), at('12:00'), [
      { start: '2026-10-21T09:00:00Z', end: '2026-10-21T10:00:00Z' },
      { start: '2026-10-21T09:30:00Z', end: '2026-10-21T10:30:00Z' },
      { start: '2026-10-21T10:45:00Z', end: '2026-10-21T11:00:00Z' },
    ], 30)).toEqual([
      { start: '2026-10-21T08:00:00.000Z', end: '2026-10-21T09:00:00.000Z' },
      { start: '2026-10-21T11:00:00.000Z', end: '2026-10-21T12:00:00.000Z' },
    ]);
  });

  it('driveLiteral escapes backslash before quote', () => {
    expect(driveLiteral("a\\'b")).toBe("'a\\\\\\'b'");
  });
});
