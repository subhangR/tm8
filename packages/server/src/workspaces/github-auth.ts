import { createHash, timingSafeEqual } from 'node:crypto';
import { CollabError, AuthGithubStartSchema } from '@tm8/contract';
import { createDb } from '../db/client.js';
import type { Db } from '../db/types.js';
import type { RequestContext } from '../http/types.js';
import { json, raw } from '../http/types.js';
import { sessionCookie } from '../http/session-cookie.js';
import { formatToken, generateSecret, hashToken } from '../identity/crypto.js';
import { publicOrigin } from './config.js';

interface Flow { verifier: string; parent_session: string | null; invitation_code: string | null }

export class LocalGithubAuth {
  private readonly enrollment: Db;
  private readonly cookieName: string;
  private readonly origin: string;
  constructor(private readonly clientId: string, private readonly clientSecret: string, origin: string, databaseUrl: string,
    private readonly request: typeof fetch = fetch) {
    this.origin = publicOrigin(origin, true);
    this.cookieName = this.origin.startsWith('https:') ? '__Host-tm8-github' : 'tm8-github';
    this.enrollment = createDb(databaseUrl, { role: 'tm8_node_enrollment', max: 2 });
  }
  private flowCookie(state: string): string {
    return `${this.cookieName}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${this.origin.startsWith('https:') ? '; Secure' : ''}`;
  }
  async start(ctx: RequestContext) {
    const result = AuthGithubStartSchema.safeParse(ctx.body);
    if (!result.success) throw new CollabError('invalid_input', 'Choose login or explicit account linking');
    const input = result.data;
    const parent = input.intent === 'link' ? ctx.identity.sessionId : null;
    if (input.intent === 'link' && (!parent || !['browser', 'cli'].includes(ctx.identity.authKind ?? ''))) {
      throw new CollabError('unauthenticated', 'Sign in before linking your GitHub account');
    }
    const state = generateSecret(), verifier = generateSecret();
    await this.enrollment.rpc({}, 'begin_local_github_flow', [hashToken(state), verifier, parent, input.claimToken ?? input.invitationCode ?? null]);
    const url = new URL('https://github.com/login/oauth/authorize');
    url.search = new URLSearchParams({ client_id: this.clientId, redirect_uri: `${this.origin}/v2/auth/github/callback`,
      scope: 'read:user user:email', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
    return json({ url: url.href }, { headers: { 'set-cookie': this.flowCookie(state), 'cache-control': 'no-store' } });
  }
  async callback(ctx: RequestContext) {
    const state = ctx.query.get('state') ?? '', code = ctx.query.get('code');
    const cookies = (ctx.headers.cookie ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${this.cookieName}=`));
    const cookie = cookies.length === 1 ? cookies[0]!.slice(this.cookieName.length + 1) : '';
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(state) || !/^[A-Za-z0-9_-]{32,128}$/.test(cookie) || state.length !== cookie.length || !timingSafeEqual(Buffer.from(state), Buffer.from(cookie)) || !code || code.length > 1024) {
      throw new CollabError('unauthenticated', 'GitHub sign-in state is invalid or expired');
    }
    const flow = await this.enrollment.rpc<Flow>({}, 'consume_local_github_flow', [hashToken(state)]);
    const tokens = await this.github<{ access_token?: string }>('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_id: this.clientId, client_secret: this.clientSecret, code,
        redirect_uri: `${this.origin}/v2/auth/github/callback`, code_verifier: flow.verifier }),
    });
    if (!tokens.access_token) throw new CollabError('unauthenticated', 'GitHub declined this sign-in');
    const headers = { authorization: `Bearer ${tokens.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'tm8' };
    const user = await this.github<{ id: number; name?: string; login: string }>('https://api.github.com/user', { headers });
    if (!Number.isSafeInteger(user.id) || user.id <= 0) throw new CollabError('unauthenticated', 'GitHub identity is invalid');
    const emails = await this.github<Array<{ email: string; primary: boolean; verified: boolean }>>('https://api.github.com/user/emails', { headers });
    const email = emails.find(value => value.primary && value.verified)?.email ?? null;
    const secret = generateSecret();
    const session = await this.enrollment.rpc<{ sessionId: string; expiresAt: string }>({}, 'complete_local_github_login',
      [String(user.id), email, user.name ?? user.login, flow.parent_session, flow.invitation_code, hashToken(secret)]);
    return raw(303, { location: '/', 'set-cookie': sessionCookie(formatToken(session.sessionId, secret), session.expiresAt),
      'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }, '');
  }
  private async github<T>(url: string, input: RequestInit): Promise<T> {
    const response = await this.request(url, { ...input, signal: AbortSignal.timeout(10000), redirect: 'error' });
    if (!response.ok) throw new CollabError('upstream_unavailable', 'GitHub sign-in is temporarily unavailable');
    return await response.json() as T;
  }
  async close(): Promise<void> { await this.enrollment.end(); }
}
