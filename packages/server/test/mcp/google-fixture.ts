import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { GoogleEndpoints } from '../../src/mcp/first-party/google/endpoints.js';

/**
 * A FIXTURE Google: the OAuth server (token, revoke, userinfo) and the subset of
 * the Gmail, Calendar and Drive REST APIs the first-party host calls, on a
 * loopback port. It keeps the provider's rules that matter to tm8 — a code is
 * single-use, the client secret is checked, an unknown or revoked access token
 * answers 401, a refresh issues a new access token and (like Google) normally
 * no new refresh token — and records every request so a test can assert on
 * exactly what left tm8.
 */
export interface GoogleFixtureRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: string;
  authorization?: string;
  contentType?: string;
}

export interface GoogleFixture {
  origin: string;
  endpoints: GoogleEndpoints;
  requests: GoogleFixtureRequest[];
  client: { clientId: string; clientSecret: string };
  email: string;
  /** Issue an authorization code, as the consent screen would after a redirect. */
  issueCode(scope?: string): string;
  /** The access token currently honoured. */
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Make every outstanding access token answer 401 (an expiry Google decided on its own). */
  expireAccess(): void;
  /** Revoke the refresh token too, so a refresh answers invalid_grant. */
  revokeRefresh(): void;
  failUserinfo: boolean;
  /** `expires_in` of every access token issued from now on. Under 30s, tm8 refreshes before each use. */
  accessTtl: number;
  /** Messages created by create_draft and send_message, decoded. */
  drafts: string[];
  sent: string[];
  calls(path: string | RegExp): GoogleFixtureRequest[];
  close(): Promise<void>;
}

const MESSAGE = {
  id: 'msg-1', threadId: 'thread-1', labelIds: ['INBOX', 'UNREAD'], snippet: 'Lunch on Friday?',
  payload: {
    mimeType: 'multipart/mixed',
    headers: [
      { name: 'From', value: 'Alice <alice@example.test>' }, { name: 'To', value: 'fixture.user@example.test' },
      { name: 'Subject', value: 'Lunch' }, { name: 'Date', value: 'Tue, 20 Oct 2026 10:00:00 +0000' },
      { name: 'Message-ID', value: '<lunch@example.test>' },
    ],
    parts: [
      { mimeType: 'multipart/alternative', parts: [
        { mimeType: 'text/plain', body: { data: Buffer.from('Lunch on Friday at noon?').toString('base64url'), size: 24 } },
        { mimeType: 'text/html', body: { data: Buffer.from('<p>Lunch on <b>Friday</b>?</p>').toString('base64url'), size: 31 } },
      ] },
      { mimeType: 'application/pdf', filename: 'menu.pdf', body: { attachmentId: 'att-1', size: 2048 } },
    ],
  },
};

const EVENT = {
  id: 'evt-1', status: 'confirmed', summary: 'Standup', htmlLink: 'https://calendar.example.test/evt-1',
  start: { dateTime: '2026-10-21T09:00:00Z' }, end: { dateTime: '2026-10-21T09:15:00Z' },
  organizer: { email: 'fixture.user@example.test' }, attendees: [{ email: 'bob@example.test', responseStatus: 'accepted' }],
};

const FILES = [
  { id: 'file-txt', name: 'notes.txt', mimeType: 'text/plain', modifiedTime: '2026-10-20T10:00:00Z', size: '11', webViewLink: 'https://drive.example.test/file-txt' },
  { id: 'file-doc', name: 'Plan', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-10-19T10:00:00Z', webViewLink: 'https://drive.example.test/file-doc' },
];

async function read(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function startGoogleFixture(): Promise<GoogleFixture> {
  const client = { clientId: 'fixture-client.apps.googleusercontent.com', clientSecret: 'fixture-client-secret-canary' };
  const email = 'fixture.user@example.test';
  const requests: GoogleFixtureRequest[] = [];
  const codes = new Map<string, string>();
  const live = new Set<string>();
  let accessToken = ''; let refreshToken = ''; let issued = 0; let refreshRevoked = false;
  let server!: Server;
  const fixture: GoogleFixture = {
    origin: '', endpoints: undefined as unknown as GoogleEndpoints, requests, client, email,
    failUserinfo: false, accessTtl: 3599, drafts: [], sent: [],
    issueCode(scope = 'openid email') { const code = `4/fixture-code-${codes.size + 1}-${Date.now()}`; codes.set(code, scope); return code; },
    get accessToken() { return accessToken; },
    get refreshToken() { return refreshToken; },
    expireAccess() { live.clear(); },
    revokeRefresh() { refreshRevoked = true; },
    calls(match: string | RegExp) { return requests.filter(request => typeof match === 'string' ? request.path === match : match.test(request.path)); },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };

  const mint = () => { issued++; accessToken = `ya29.fixture-access-${issued}`; live.add(accessToken); return accessToken; };

  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture');
    const body = await read(req);
    requests.push({ method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, body, authorization: req.headers.authorization, contentType: req.headers['content-type'] });
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    const path = url.pathname;

    // ── OAuth ───────────────────────────────────────────────────────────
    if (path === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(body);
      if (form.get('client_id') !== client.clientId || form.get('client_secret') !== client.clientSecret) return json(401, { error: 'invalid_client' });
      if (form.get('grant_type') === 'authorization_code') {
        const scope = codes.get(form.get('code') ?? '');
        if (scope === undefined || !form.get('code_verifier') || !form.get('redirect_uri')) return json(400, { error: 'invalid_grant' });
        codes.delete(form.get('code')!);
        refreshToken = `1//fixture-refresh-${issued + 1}`; refreshRevoked = false;
        return json(200, { access_token: mint(), refresh_token: refreshToken, expires_in: fixture.accessTtl, token_type: 'Bearer', scope, id_token: 'fixture.id.token' });
      }
      if (form.get('grant_type') === 'refresh_token') {
        if (refreshRevoked || form.get('refresh_token') !== refreshToken) return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
        return json(200, { access_token: mint(), expires_in: fixture.accessTtl, token_type: 'Bearer', scope: 'openid email' });
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (path === '/revoke' && req.method === 'POST') {
      const token = new URLSearchParams(body).get('token');
      if (token === refreshToken) { refreshRevoked = true; live.clear(); }
      live.delete(token ?? '');
      return json(200, {});
    }

    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
    if (!live.has(bearer)) return json(401, { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } });

    if (path === '/userinfo') {
      if (fixture.failUserinfo) return json(500, { error: 'backend' });
      return json(200, { sub: '1234567890', email, email_verified: true });
    }

    // ── Gmail ───────────────────────────────────────────────────────────
    if (path === '/gmail/v1/users/me/messages' && req.method === 'GET') return json(200, { messages: [{ id: 'msg-1', threadId: 'thread-1' }], resultSizeEstimate: 1 });
    if (path === '/gmail/v1/users/me/messages/msg-1') return json(200, MESSAGE);
    if (path.startsWith('/gmail/v1/users/me/messages/') && req.method === 'GET') return json(404, { error: { code: 404, message: 'Requested entity was not found.' } });
    if (path === '/gmail/v1/users/me/threads/thread-1') return json(200, { id: 'thread-1', messages: [MESSAGE] });
    if (path === '/gmail/v1/users/me/labels') return json(200, { labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'Label_1', name: 'Receipts', type: 'user' }] });
    if (path === '/gmail/v1/users/me/drafts' && req.method === 'POST') {
      const { message } = JSON.parse(body) as { message: { raw: string; threadId?: string } };
      fixture.drafts.push(Buffer.from(message.raw, 'base64url').toString('utf8'));
      return json(200, { id: 'draft-1', message: { id: 'msg-draft-1', threadId: message.threadId ?? 'thread-new' } });
    }
    if (path === '/gmail/v1/users/me/messages/send' && req.method === 'POST') {
      const { raw, threadId } = JSON.parse(body) as { raw: string; threadId?: string };
      fixture.sent.push(Buffer.from(raw, 'base64url').toString('utf8'));
      return json(200, { id: 'msg-sent-1', threadId: threadId ?? 'thread-sent' });
    }

    // ── Calendar ────────────────────────────────────────────────────────
    if (path === '/calendar/v3/users/me/calendarList') return json(200, { items: [{ id: 'primary-id', summary: 'Fixture User', primary: true, accessRole: 'owner', timeZone: 'UTC' }] });
    if (path === '/calendar/v3/calendars/primary/events' && req.method === 'GET') return json(200, { timeZone: 'UTC', items: [EVENT] });
    if (path === '/calendar/v3/calendars/primary/events/evt-1' && req.method === 'GET') return json(200, EVENT);
    if (path === '/calendar/v3/calendars/primary/events' && req.method === 'POST') return json(200, { ...EVENT, id: 'evt-new', ...JSON.parse(body) });
    if (path === '/calendar/v3/calendars/primary/events/evt-1' && req.method === 'PATCH') return json(200, { ...EVENT, ...JSON.parse(body) });
    if (path === '/calendar/v3/freeBusy' && req.method === 'POST') {
      const asked = JSON.parse(body) as { items: { id: string }[] };
      return json(200, { calendars: Object.fromEntries(asked.items.map(item => [item.id, { busy: [{ start: '2026-10-21T09:00:00Z', end: '2026-10-21T10:00:00Z' }] }])) });
    }

    // ── Drive ───────────────────────────────────────────────────────────
    if (path === '/drive/v3/files' && req.method === 'GET') return json(200, { files: FILES });
    if (path === '/drive/v3/files/file-txt' && url.searchParams.get('alt') === 'media') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('hello drive'); return; }
    if (path === '/drive/v3/files/file-txt') return json(200, FILES[0]);
    if (path === '/drive/v3/files/file-doc') return json(200, FILES[1]);
    if (path === '/drive/v3/files/file-doc/export') { res.writeHead(200, { 'content-type': url.searchParams.get('mimeType') ?? 'text/plain' }); res.end('# Plan\n\nShip it.'); return; }
    if (path === '/upload/drive/v3/files' && req.method === 'POST') {
      const meta = JSON.parse(body.split('\r\n\r\n')[1]!.split('\r\n')[0]!) as { name: string; mimeType?: string; parents?: string[] };
      return json(200, { id: 'file-new', name: meta.name, mimeType: meta.mimeType ?? 'text/plain', parents: meta.parents ?? ['root'] });
    }
    return json(404, { error: { code: 404, message: `fixture has no ${req.method} ${path}` } });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  fixture.origin = origin;
  fixture.endpoints = {
    issuer: 'https://accounts.google.com',
    authorization: `${origin}/o/oauth2/v2/auth`, token: `${origin}/token`, revocation: `${origin}/revoke`, userinfo: `${origin}/userinfo`,
    gmail: `${origin}/gmail/v1`, calendar: `${origin}/calendar/v3`, drive: `${origin}/drive/v3`, driveUpload: `${origin}/upload/drive/v3`,
  };
  return fixture;
}
