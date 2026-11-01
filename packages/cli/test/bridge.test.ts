import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BridgeConnectionOfferInputSchema, BridgeConnectionRemoveInputSchema, BridgeConnectionWithdrawInputSchema,
  BridgeConversationCreateInputSchema, BridgeWorkStartInputSchema,
  type BridgeConnectionAuthFrame, type BridgeConnectionView, type BridgeDetailView,
} from '@tm8/contract';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/run.js';
import { parseQuietHours, renderBridge, renderConnection, setConnectionAuthStreamForTests, writeQrFile } from '../src/commands/bridge.js';
import { nounHelp } from '../src/discovery/help.js';

const SPACE = '33333333-3333-7333-8333-333333333333';
const BRIDGE = '11111111-1111-7111-8111-111111111111';
const CHAT = '22222222-2222-7222-8222-222222222222';
const CONNECTION = '44444444-4444-7444-8444-444444444444';
const CREDENTIAL = '55555555-5555-7555-8555-555555555555';
const ACCOUNT = '66666666-6666-7666-8666-666666666666';
const connectionView = (status: BridgeConnectionView['status']): BridgeConnectionView => ({
  id: CONNECTION, provider: 'whatsapp', ownerAccountId: ACCOUNT, label: 'Infra phone',
  externalAccountId: status === 'linked' ? '919494@s.whatsapp.net' : null, status, runtimeId: 'rt-1',
  createdAt: '2026-10-30T05:00:00.000Z', lastSeenAt: null,
  offers: [{ credentialId: CREDENTIAL, spaceId: SPACE, visibility: 'public', status: 'active', createdAt: '2026-10-30T05:01:00.000Z', bridges: 2 }],
});
let connectionStatus: BridgeConnectionView['status'] = 'connecting';
let beginRuntime: 'connecting' | 'offline' = 'connecting';

const view: BridgeDetailView = {
  id: BRIDGE, spaceId: SPACE, version: 3, title: 'Infra', createdAt: '2026-10-29T22:00:00.000Z', updatedAt: '2026-10-29T22:00:00.000Z',
  provider: 'whatsapp', connectionId: CONNECTION, connectionCredentialId: CREDENTIAL,
  conversation: { externalId: '1203@g.us', kind: 'group', title: 'Infra', memberCount: 7 },
  target: { kind: 'chat', id: CHAT, title: 'Infra main' },
  policy: { trigger: 'mention', direction: 'both', outbound: 'replies', whoMayTrigger: 'linked', voice: 'named', style: null },
  status: 'live',
  health: { connection: 'linked', lastInboundAt: null, lastOutboundAt: null, queued: 0, failed24h: 0, detail: null },
  people: { participants: 4, linked: 1, guestsSeen7d: 3 }, handles: 2, retentionDays: null, teammateId: null,
  purpose: 'Infra on-call', quietHours: { start: '22:00', end: '08:00' }, workerPosting: true, workers: { wake: 'directed' },
  pausedAt: null, endedAt: null,
  recentPosters: [{ actorId: CHAT, actorKind: 'team_member', displayName: 'Infra', handle: 'keen-otter', posts: 3, lastPostAt: '2026-10-29T22:10:00.000Z' }],
};

const LINK = {
  id: CONNECTION, provider: 'whatsapp', externalId: '919000000001@s.whatsapp.net', masked: '…0001', method: 'code', trust: 'linked',
  spaceId: null, spaceName: null, verifiedAt: '2026-10-28T10:00:00.000Z', revokedAt: null,
};

// Bridges P (420, D50-D52): one linked member and one guest, masked as a member sees them.
const PEOPLE = [
  { externalId: '…0001', altExternalIds: [], masked: true, displayName: 'Subhang', avatarRef: null, muted: false,
    firstSeenAt: view.createdAt, lastSeenAt: view.createdAt, messageCount: 214, trust: 'linked', memberId: CHAT,
    member: { id: CHAT, kind: 'member', displayName: 'Subhang' }, link: { method: 'code', verifiedAt: view.createdAt }, you: true },
  { externalId: '…9494', altExternalIds: [], masked: true, displayName: 'Rahul', avatarRef: null, muted: false,
    firstSeenAt: view.createdAt, lastSeenAt: view.createdAt, messageCount: 37, trust: 'guest', memberId: null,
    member: null, link: null, you: false },
];

let server: Server;
let requests: Array<{ method: string; path: string; query: URLSearchParams; body: Record<string, any> }> = [];
let stdout = '', stderr = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url!, 'http://localhost');
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any> : {};
      requests.push({ method: req.method!, path: url.pathname, query: url.searchParams, body });
      let data: unknown = view;
      if (url.pathname.endsWith('/bridges') && req.method === 'GET') data = { items: [view] };
      else if (url.pathname.endsWith('/handles') && req.method === 'POST') data = { spaceId: SPACE, handle: 'keen-otter', entityId: CHAT, kind: 'work_session', title: null, status: 'live', createdAt: view.createdAt };
      else if (url.pathname.endsWith('/listen')) data = { bridgeId: BRIDGE, sessionId: CHAT, wake: body.wake, ceiling: 'thread' };
      else if (url.pathname === '/v2/me/bridge-connections' && req.method === 'GET') data = { items: [connectionView(connectionStatus)] };
      else if (url.pathname === '/v2/me/bridge-connections') data = { connection: connectionView('connecting'), runtime: beginRuntime };
      else if (url.pathname.endsWith('/offer')) data = { connection: connectionView('linked'), credentialId: CREDENTIAL };
      else if (url.pathname.endsWith('/remove')) data = { connection: { ...connectionView('linked'), status: 'removed', offers: [] }, endedBridgeIds: [BRIDGE], revokedCredentialIds: [CREDENTIAL], runtime: 'logged_out' };
      else if (url.pathname.endsWith('/conversations') && req.method === 'POST') data = { connectionId: CONNECTION, bridge: null,
        group: { conversationId: '1204@g.us', subject: body.title, results: [], inviteLink: null } };
      else if (url.pathname.endsWith('/conversations')) data = { connectionId: CONNECTION, items: [
        { conversationId: '1203@g.us', kind: 'group', name: 'Infra', size: 7, canSend: true, reason: null },
        { conversationId: '9999@g.us', kind: 'group', name: 'Announcements', size: 120, canSend: false, reason: 'admins_only' }] };
      else if (url.pathname.endsWith('/withdraw')) data = { connection: connectionView('linked'), credentialId: CREDENTIAL, pausedBridgeIds: [BRIDGE] };
      else if (url.pathname.endsWith('/work')) data = { bridgeId: BRIDGE, parentTaskId: null, items: [{ taskId: CHAT, sessionId: CHAT, handle: 'keen-otter', error: null }], noticeMessageId: CHAT };
      else if (url.pathname === '/v2/identity/bridge-links' && req.method === 'POST') data = { code: 'TM8-4F7KQ2', provider: body.provider, expiresAt: '2026-10-30T06:40:00.000Z', createdAt: '2026-10-30T06:30:00.000Z' };
      else if (url.pathname === '/v2/identity/bridge-links') data = { items: [LINK], pending: [{ id: CHAT, provider: 'whatsapp', expiresAt: '2026-10-30T06:40:00.000Z', createdAt: '2026-10-30T06:30:00.000Z' }] };
      else if (url.pathname.endsWith('/revoke')) data = { ...LINK, revokedAt: '2026-10-30T06:35:00.000Z' };
      else if (url.pathname.endsWith('/invites')) data = { id: CHAT, code: 'inv_abc', role: 'member', maxUses: 1, uses: 0, expiresAt: null, revoked: false };
      else if (url.pathname.endsWith('/participants')) data = { bridgeId: BRIDGE, spaceId: SPACE, admin: false, items: PEOPLE };
      else if (url.pathname.includes('/participants/')) data = { bridgeId: BRIDGE, externalId: decodeURIComponent(url.pathname.split('/').pop()!), changed: true, participant: { ...PEOPLE[1], muted: body.patch?.muted ?? false } };
      else if (url.pathname.endsWith('/log')) data = { bridgeId: BRIDGE, logAnchorId: BRIDGE, items: [], lastMessageId: null, more: false };
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data, requestId: 'test' }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server port');
  vi.stubEnv('TM8_BASE_URL', `http://127.0.0.1:${address.port}`); vi.stubEnv('TM8_SPACE_ID', SPACE); vi.stubEnv('TM8_CREDENTIALS_MODE', 'off');
  vi.stubEnv('TM8_SESSION_ID', ''); vi.stubEnv('TM8_AGENT_TOKEN', ''); vi.stubEnv('TM8_TEAM_MEMBER_ID', '');
  vi.stubEnv('TM8_JOURNAL_CLASS', 'human'); vi.stubEnv('TM8_NO_TERSE_DEFAULT', '1');
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => { stdout += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => { stderr += String(chunk); return true; });
  await run(['bridge', 'list']);
}, 60_000);
afterAll(async () => { vi.restoreAllMocks(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => { requests = []; stdout = ''; stderr = ''; });

describe('tm8 bridge (B0a)', () => {
  it('parses quiet hours and refuses a malformed window', () => {
    expect(parseQuietHours('22:00-08:00')).toEqual({ start: '22:00', end: '08:00' });
    expect(parseQuietHours('none')).toBeNull();
    expect(parseQuietHours(undefined)).toBeUndefined();
    expect(() => parseQuietHours('22-8')).toThrow(/HH:MM-HH:MM/);
    expect(() => parseQuietHours('09:00-09:00')).toThrow(/differ/);
  });

  it('show renders the derived status, purpose and recent posters', () => {
    const text = renderBridge(view);
    expect(text).toMatch(/· live · whatsapp group "Infra"/);
    expect(text).toMatch(/purpose: Infra on-call/);
    expect(text).toMatch(/quiet 22:00-08:00/);
    expect(text).toMatch(/Infra \(keen-otter\) · team_member/);
  });

  it('the noun shard lists every B0a verb', () => {
    const paths = nounHelp('bridge')!.commands.map(c => c.command);
    for (const p of ['list', 'show', 'get', 'create', 'update', 'retarget', 'pause', 'resume', 'remove', 'handles', 'handle claim', 'log', 'listen', 'work']) {
      expect(paths).toContain(`bridge ${p}`);
    }
  });

  it('work sends the items and options to bridges.work.start (B1b-6)', async () => {
    expect(await run(['bridge', 'work', BRIDGE, '--item', 'fix the login timeout', '--item', 'release notes',
      '--teammate', 'Infra Bot', '--effort', 'high', '--mutation-id', 'mid-1'])).toBe(0);
    expect(requests[0]).toMatchObject({ method: 'POST', path: `/v2/bridges/${BRIDGE}/work` });
    expect(requests[0]!.body).toMatchObject({
      clientMutationId: 'mid-1', items: ['fix the login timeout', 'release notes'], options: { teammate: 'Infra Bot', effort: 'high' },
    });
    expect(stdout).toContain('keen-otter starting');
    expect(await run(['bridge', 'work', BRIDGE])).not.toBe(0);
    expect(await run(['bridge', 'work', BRIDGE, '--item', 'x', '--effort', 'huge'])).not.toBe(0);
  });

  it('list sends the filters to bridges.list', async () => {
    expect(await run(['bridge', 'list', '--provider', 'whatsapp', '--include-ended'])).toBe(0);
    expect(requests[0]).toMatchObject({ method: 'GET', path: `/v2/spaces/${SPACE}/bridges` });
    expect(requests[0]!.query.get('provider')).toBe('whatsapp');
    expect(requests[0]!.query.get('includeEnded')).toBe('true');
  });

  it('create sends the connection, the conversation, the target and the overlaid policy', async () => {
    expect(await run(['bridge', 'create', '--connection', CONNECTION, '--conversation', '1203@g.us', '--title', 'Infra',
      '--to', CHAT, '--trigger', 'every', '--purpose', 'Infra on-call', '--quiet-hours', '22:00-08:00', '--worker-posting', 'off'])).toBe(0);
    expect(requests[0]).toMatchObject({ method: 'POST', path: `/v2/spaces/${SPACE}/bridges` });
    expect(requests[0]!.body).toMatchObject({
      connectionId: CONNECTION, targetId: CHAT, conversation: { externalId: '1203@g.us', kind: 'group', title: 'Infra' },
      policy: { trigger: 'every' }, purpose: 'Infra on-call', quietHours: { start: '22:00', end: '08:00' }, workerPosting: false,
    });
    expect(typeof requests[0]!.body.clientMutationId).toBe('string');
  });

  it('update needs a version and at least one setting', async () => {
    expect(await run(['bridge', 'update', BRIDGE, '--purpose', 'x'])).toBe(2);
    expect(await run(['bridge', 'update', BRIDGE, '--expect-version', '3'])).toBe(2);
    expect(await run(['bridge', 'update', BRIDGE, '--expect-version', '3', '--worker-wake', 'thread', '--style', 'none'])).toBe(0);
    expect(requests.at(-1)!.body).toMatchObject({ expectedVersion: 3, patch: { workerWake: 'thread', policy: { style: null } } });
  });

  it('pause, retarget and remove are versioned', async () => {
    expect(await run(['bridge', 'pause', BRIDGE, '--expect-version', '3'])).toBe(0);
    expect(requests.at(-1)).toMatchObject({ method: 'POST', path: `/v2/bridges/${BRIDGE}/pause`, body: { expectedVersion: 3 } });
    expect(await run(['bridge', 'retarget', BRIDGE, '--to', CHAT, '--expect-version', '3'])).toBe(0);
    expect(requests.at(-1)!.body).toMatchObject({ expectedVersion: 3, targetId: CHAT });
    expect(await run(['bridge', 'remove', BRIDGE])).toBe(2);
  });

  it('handle claim resolves the space from a bridge id; listen and log reach their doors', async () => {
    expect(await run(['bridge', 'handle', 'claim', BRIDGE, '--title', 'deploy watcher'])).toBe(0);
    expect(requests.map(r => `${r.method} ${r.path}`)).toEqual([`GET /v2/bridges/${BRIDGE}`, `POST /v2/spaces/${SPACE}/handles`]);
    expect(requests[1]!.body).toEqual({ title: 'deploy watcher' });
    expect(stdout).toMatch(/keen-otter/);
    expect(await run(['bridge', 'listen', BRIDGE, 'thread'])).toBe(0);
    expect(requests.at(-1)!.body).toEqual({ wake: 'thread' });
    expect(await run(['bridge', 'listen', BRIDGE, 'loud'])).toBe(2);
    expect(await run(['bridge', 'log', BRIDGE, '--unread', '--limit', '20'])).toBe(0);
    expect(requests.at(-1)!.query.get('unread')).toBe('true');
    expect(await run(['bridge', 'log', BRIDGE, '--unread', '--since', CHAT])).toBe(2);
    // The newest page and scroll-back: one way to choose the page.
    expect(await run(['bridge', 'log', BRIDGE, '--latest', '--limit', '20'])).toBe(0);
    expect(requests.at(-1)!.query.get('latest')).toBe('true');
    expect(requests.at(-1)!.query.get('unread')).toBeNull();
    expect(await run(['bridge', 'log', BRIDGE, '--before', CHAT])).toBe(0);
    expect(requests.at(-1)!.query.get('before')).toBe(CHAT);
    expect(await run(['bridge', 'log', BRIDGE, '--latest', '--unread'])).toBe(2);
    expect(await run(['bridge', 'log', BRIDGE, '--before', CHAT, '--since', CHAT])).toBe(2);
  });

  it('entity create bridge names the bridge door', async () => {
    expect(await run(['entity', 'create', 'bridge', 'Infra'])).toBe(2);
    expect(stderr).toMatch(/use `tm8 bridge create`/);
    expect(requests).toEqual([]);
  });

  it('link begin prints the /link line once; list and revoke reach their doors (B3, D58)', async () => {
    expect(await run(['bridge', 'link', 'begin'])).toBe(0);
    expect(requests.at(-1)).toMatchObject({ method: 'POST', path: '/v2/identity/bridge-links', body: { provider: 'whatsapp' } });
    expect(stdout).toMatch(/\/link TM8-4F7KQ2/);
    expect(await run(['bridge', 'link', 'begin', '--provider', 'fax'])).toBe(2);
    expect(await run(['bridge', 'link', 'list'])).toBe(0);
    expect(stdout).toMatch(/…0001 · linked ✓ by code/);
    expect(stdout).toMatch(/pending whatsapp code/);
    expect(await run(['bridge', 'link', 'revoke', CONNECTION])).toBe(0);
    expect(requests.at(-1)).toMatchObject({ method: 'POST', path: `/v2/identity/bridge-links/${CONNECTION}/revoke` });
    expect(stdout).toMatch(/unlinked:/);
  });

  it('invite pins the participant to a one-use invite in the bridge\'s space (D60)', async () => {
    expect(await run(['bridge', 'invite', BRIDGE, '919000000002@s.whatsapp.net'])).toBe(0);
    expect(requests.map(r => `${r.method} ${r.path}`)).toEqual([`GET /v2/bridges/${BRIDGE}`, `POST /v2/spaces/${SPACE}/invites`]);
    expect(requests[1]!.body).toMatchObject({ maxUses: 1, bridgeParticipant: { bridgeId: BRIDGE, externalId: '919000000002@s.whatsapp.net' } });
    expect(stdout).toMatch(/\/join\/inv_abc/);
    expect(await run(['bridge', 'invite', BRIDGE])).toBe(2);
  });

  it('people reads the roster and filters linked from guests (Bridges P, D50)', async () => {
    expect(await run(['bridge', 'people', BRIDGE, '--guests'])).toBe(0);
    expect(requests[0]).toMatchObject({ method: 'GET', path: `/v2/bridges/${BRIDGE}/participants` });
    expect(stdout).toContain('Rahul'); expect(stdout).toContain('…9494'); expect(stdout).not.toContain('Subhang');
    stdout = '';
    expect(await run(['bridge', 'people', BRIDGE, '--linked'])).toBe(0);
    expect(stdout).toContain('linked ✓'); expect(stdout).toContain('(you)'); expect(stdout).not.toContain('Rahul');
    expect(await run(['bridge', 'people', BRIDGE, '--linked', '--guests'])).toBe(2);
  });

  it('participant sends exactly the patch it was given (Bridges P, D52)', async () => {
    const ext = '919811109494@s.whatsapp.net';
    expect(await run(['bridge', 'participant', BRIDGE, ext, '--mute', 'on'])).toBe(0);
    expect(requests.at(-1)).toMatchObject({ method: 'PATCH', path: `/v2/bridges/${BRIDGE}/participants/${encodeURIComponent(ext)}`, body: { patch: { muted: true } } });
    expect(stdout).toContain('updated'); expect(stdout).toContain('muted');
    expect(await run(['bridge', 'participant', BRIDGE, ext, '--member', CHAT])).toBe(0);
    expect(requests.at(-1)!.body.patch).toEqual({ memberId: CHAT });
    expect(await run(['bridge', 'participant', BRIDGE, ext, '--unassert'])).toBe(0);
    expect(requests.at(-1)!.body.patch).toEqual({ memberId: null });
    expect(await run(['bridge', 'participant', BRIDGE, ext])).toBe(2);
    expect(await run(['bridge', 'participant', BRIDGE, ext, '--member', CHAT, '--unassert'])).toBe(2);
  });
});

describe('tm8 bridge connection (B1b-5)', () => {
  let sent: BridgeConnectionAuthFrame[] = [];
  let opened = 0, closed = 0;
  beforeEach(() => {
    sent = []; opened = 0; closed = 0; connectionStatus = 'connecting'; beginRuntime = 'connecting';
    setConnectionAuthStreamForTests(() => {
      let deliver: ((f: BridgeConnectionAuthFrame) => void) | null = null;
      return {
        open: async () => { opened += 1; },
        onFrame: fn => { deliver = fn; queueMicrotask(() => { for (const f of sent) deliver?.(f); }); },
        close: () => { closed += 1; },
      };
    });
  });
  afterAll(() => setConnectionAuthStreamForTests(null));

  it('the noun shard lists the connection verbs', () => {
    const paths = nounHelp('bridge')!.commands.map(c => c.command);
    for (const p of ['list', 'begin', 'offer', 'withdraw', 'remove']) expect(paths).toContain(`bridge connection ${p}`);
    expect(paths).toContain('bridge conversations');
  });

  it('list reaches bridges.connections.list and renders the offers', async () => {
    expect(await run(['bridge', 'connection', 'list', '--provider', 'whatsapp'])).toBe(0);
    expect(requests[0]).toMatchObject({ method: 'GET', path: '/v2/me/bridge-connections' });
    expect(requests[0]!.query.get('provider')).toBe('whatsapp');
    expect(stdout).toMatch(new RegExp(`offered to space ${SPACE} as credential ${CREDENTIAL} · space · active · 2 bridges`));
    expect(renderConnection({ ...connectionView('connecting'), offers: [] })).toMatch(/no space yet/);
  });

  it('begin opens the socket first, shows the pairing code from the socket, and stops when linked', async () => {
    sent = [{ type: 'bridge.connection.auth', connectionId: CONNECTION, pairingCode: 'ABCD-1234', expiresAt: '2026-10-30T05:10:00.000Z' }];
    connectionStatus = 'linked';
    expect(await run(['bridge', 'connection', 'begin', '--provider', 'whatsapp', '--label', 'Infra phone', '--pairing', '+919494000000'])).toBe(0);
    expect(opened).toBe(1);
    expect(closed).toBe(1);
    expect(requests[0]).toMatchObject({ method: 'POST', path: '/v2/me/bridge-connections' });
    expect(requests[0]!.body).toMatchObject({ provider: 'whatsapp', label: 'Infra phone', authFlow: { kind: 'pairing', phone: '+919494000000' } });
    expect(stderr).toMatch(/pairing code: ABCD-1234/);
    expect(stdout).toMatch(/linked\. Next: tm8 bridge connection offer/);
  });

  it('begin writes a QR to a private file and ignores another connection\'s frame', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm8-b1b5-test-'));
    const path = join(dir, 'qr.png');
    sent = [
      { type: 'bridge.connection.auth', connectionId: 'someone-else', pairingCode: 'NOPE-0000', expiresAt: '2026-10-30T05:10:00.000Z' },
      { type: 'bridge.connection.auth', connectionId: CONNECTION, qrPng: Buffer.from('png-bytes').toString('base64'), expiresAt: '2026-10-30T05:10:00.000Z' },
    ];
    connectionStatus = 'linked';
    expect(await run(['bridge', 'connection', 'begin', '--provider', 'whatsapp', '--qr-file', path])).toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('png-bytes');
    expect(stderr).not.toMatch(/NOPE-0000/);
    expect(stderr).toMatch(new RegExp(`QR written to ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    rmSync(dir, { recursive: true, force: true });
  });

  it('begin\'s default QR file is 0600 in a fresh 0700 directory', async () => {
    sent = [{ type: 'bridge.connection.auth', connectionId: CONNECTION, qrPng: Buffer.from('png').toString('base64'), expiresAt: '2026-10-30T05:10:00.000Z' }];
    connectionStatus = 'linked';
    expect(await run(['bridge', 'connection', 'begin', '--provider', 'whatsapp'])).toBe(0);
    const path = /QR written to (\S+)/.exec(stderr)![1]!;
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
    rmSync(join(path, '..'), { recursive: true, force: true });
  });

  it('begin refuses an existing --qr-file, a 0644 file or a symlink, before calling the server, and leaves it untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm8-b1b5-test-'));
    const planted = join(dir, 'planted.png'), target = join(dir, 'target.txt'), link = join(dir, 'link.png');
    writeFileSync(planted, 'theirs', { mode: 0o644 });
    writeFileSync(target, 'target', { mode: 0o644 });
    symlinkSync(target, link);
    sent = [{ type: 'bridge.connection.auth', connectionId: CONNECTION, qrPng: Buffer.from('png').toString('base64'), expiresAt: '2026-10-30T05:10:00.000Z' }];
    for (const path of [planted, link]) {
      expect(await run(['bridge', 'connection', 'begin', '--provider', 'whatsapp', '--qr-file', path])).toBe(2);
      expect(stderr).toMatch(/already exists/);
    }
    expect(requests).toEqual([]);
    expect(readFileSync(planted, 'utf8')).toBe('theirs');
    expect(readFileSync(target, 'utf8')).toBe('target');
    rmSync(dir, { recursive: true, force: true });
  });

  it('writeQrFile never follows a symlink planted after the check, and replaces only its own file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm8-b1b5-test-'));
    const target = join(dir, 'target.txt'), path = join(dir, 'qr.png');
    writeFileSync(target, 'target', { mode: 0o644 });
    writeQrFile(path, Buffer.from('one'), 0);
    rmSync(path);
    symlinkSync(target, path);
    writeQrFile(path, Buffer.from('two'), 1);
    expect(readFileSync(target, 'utf8')).toBe('target');
    expect(readFileSync(path, 'utf8')).toBe('two');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => writeQrFile(join(dir, 'target.txt'), Buffer.from('x'), 0)).toThrow(/already exists/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('begin says so when no runtime is running, and --no-wait opens no socket', async () => {
    beginRuntime = 'offline';
    expect(await run(['bridge', 'connection', 'begin', '--provider', 'whatsapp'])).toBe(0);
    expect(stdout).toMatch(/no whatsapp runtime is running/);
    beginRuntime = 'connecting'; opened = 0;
    expect(await run(['bridge', 'connection', 'begin', '--provider', 'whatsapp', '--no-wait'])).toBe(0);
    expect(opened).toBe(0);
    expect(await run(['bridge', 'connection', 'begin'])).toBe(2);
  });

  it('offer and withdraw name the connection and the space', async () => {
    expect(await run(['bridge', 'connection', 'offer', CONNECTION, '--visibility', 'space'])).toBe(0);
    expect(requests.at(-1)).toMatchObject({ method: 'POST', path: `/v2/me/bridge-connections/${CONNECTION}/offer` });
    expect(requests.at(-1)!.body).toMatchObject({ spaceId: SPACE, visibility: 'public' });
    expect(stdout).toMatch(new RegExp(`offered as credential ${CREDENTIAL}`));
    expect(await run(['bridge', 'connection', 'withdraw', CONNECTION])).toBe(0);
    expect(requests.at(-1)).toMatchObject({ method: 'POST', path: `/v2/me/bridge-connections/${CONNECTION}/withdraw`, body: { spaceId: SPACE } });
    expect(stdout).toMatch(/paused 1 bridge: /);
    expect(await run(['bridge', 'connection', 'offer'])).toBe(2);
  });

  it('remove names the connection; conversations lists the owner\'s groups live (B1b-7)', async () => {
    expect(await run(['bridge', 'connection', 'remove', CONNECTION])).toBe(0);
    expect(requests.at(-1)).toMatchObject({ method: 'POST', path: `/v2/me/bridge-connections/${CONNECTION}/remove` });
    expect(typeof requests.at(-1)!.body.clientMutationId).toBe('string');
    expect(stdout).toMatch(/ended 1 bridge: /);
    expect(stdout).toMatch(/the device was logged out/);
    expect(await run(['bridge', 'conversations', CONNECTION])).toBe(0);
    expect(requests.at(-1)).toMatchObject({ method: 'GET', path: `/v2/me/bridge-connections/${CONNECTION}/conversations` });
    expect(stdout).toMatch(/1203@g.us  group "Infra" · 7 members/);
    expect(stdout).toMatch(/read-only \(admins_only\)/);
    expect(await run(['bridge', 'conversations'])).toBe(2);
  });

  // An agent run always has an actor, and the CLI's mutation envelope carries it
  // as `actorId`; the server validates each body against these strict schemas
  // before it checks who is asking, so a schema without the envelope turned an
  // agent's refusal into invalid_input (and refused any caller with an actor).
  it('every bridge mutation body, actorId included, passes its contract input schema', async () => {
    const ACTOR = '77777777-7777-7777-8777-777777777777';
    vi.stubEnv('TM8_ACTOR_ID', ACTOR);
    try {
      const cases: Array<[string[], { safeParse(v: unknown): { success: boolean; error?: unknown } }]> = [
        [['bridge', 'group', 'create', CONNECTION, '--title', 'bridges-test', '--participant', '+91 98765 43210'], BridgeConversationCreateInputSchema],
        [['bridge', 'work', BRIDGE, '--item', 'fix the login timeout'], BridgeWorkStartInputSchema],
        [['bridge', 'connection', 'offer', CONNECTION], BridgeConnectionOfferInputSchema],
        [['bridge', 'connection', 'withdraw', CONNECTION], BridgeConnectionWithdrawInputSchema],
        [['bridge', 'connection', 'remove', CONNECTION], BridgeConnectionRemoveInputSchema],
      ];
      for (const [argv, schema] of cases) {
        expect(await run(argv), `${argv.join(' ')}: ${stderr}`).toBe(0);
        const body = requests.at(-1)!.body;
        expect(body.actorId, argv.join(' ')).toBe(ACTOR);
        const parsed = schema.safeParse(body);
        expect(parsed.success, `${argv.join(' ')}: ${JSON.stringify(parsed.error)}`).toBe(true);
      }
      expect(requests.at(0)).toMatchObject({ method: 'POST', path: `/v2/me/bridge-connections/${CONNECTION}/conversations` });
      expect(stdout).toMatch(/group 1204@g.us "bridges-test"/);
    } finally {
      vi.stubEnv('TM8_ACTOR_ID', '');
    }
  });
});
