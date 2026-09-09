import { createHash } from 'node:crypto';
import { DirectoryError, hash, secret } from './directory.mjs';

export function origin(value, allowLocal = false) {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (url.protocol !== 'https:' && !(allowLocal && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('Expected a bare HTTPS origin');
  }
  return url.origin;
}

/** Supabase tokens terminate here. They are never forwarded to workspace nodes. */
export class SupabaseAuth {
  constructor({ url, key, publicOrigin, pool, fetchImpl = fetch }) {
    this.url = origin(url);
    this.key = key;
    this.publicOrigin = publicOrigin;
    this.pool = pool;
    this.fetch = fetchImpl;
  }
  async request(path, body, token, method) {
    const response = await this.fetch(`${this.url}/auth/v1/${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { apikey: this.key, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000), redirect: 'error',
    });
    if (!response.ok) throw new DirectoryError('authentication_failed', 401);
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }
  githubIdentity(user) {
    const identity = user.identities?.find(value => value.provider === 'github');
    const subject = identity?.identity_data?.sub ?? identity?.identity_data?.provider_id;
    if (!subject || !/^[0-9]{1,20}$/.test(String(subject))) throw new DirectoryError('github_identity_required', 401);
    return { ...user, tm8Method: 'github', tm8GithubSubject: String(subject) };
  }
  async startGithub(invitationCode, parentSessionId = null) {
    const state = secret();
    const verifier = secret();
    await this.pool.query(`insert into tm8_directory.auth_flows(state_hash,verifier,invitation_code,expires_at,parent_session_id,kind)
      values($1,$2,$3,now()+interval '10 minutes',$4,'github')`, [hash(state), verifier, invitationCode ?? null, parentSessionId]);
    const query = new URLSearchParams({
      provider: 'github', redirect_to: `${this.publicOrigin}/auth/callback`,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 's256',
      scopes: 'read:user user:email',
    });
    return { state, url: `${this.url}/auth/v1/authorize?${query}` };
  }
  async finishGithub(state, code) {
    if (!state || !code) throw new DirectoryError('invalid_auth_flow', 401);
    const { rows } = await this.pool.query(`delete from tm8_directory.auth_flows
      where state_hash=$1 and expires_at>now() and kind='github' returning verifier,invitation_code,kind,parent_session_id`, [hash(state)]);
    if (!rows[0]) throw new DirectoryError('invalid_auth_flow', 401);
    const tokens = await this.request('token?grant_type=pkce', { auth_code: code, code_verifier: rows[0].verifier });
    const user = await this.request('user', undefined, tokens.access_token);
    return { user: this.githubIdentity(user), invitationCode: rows[0].invitation_code, parentSessionId: rows[0].parent_session_id };
  }
}
