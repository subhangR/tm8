import { createHash, randomBytes } from 'node:crypto';
import { CollabError } from '@tm8/contract';
import { mcpHttp } from './transport.js';
import type { McpOAuthSecret } from './credential-store.js';

type TokenEndpointAuthMethod = 'none' | 'client_secret_basic' | 'client_secret_post';

interface Metadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  code_challenge_methods_supported?: string[];
  response_types_supported?: string[];
  registration_endpoint?: string;
  revocation_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
}

interface OAuthClient {
  id: string;
  method: TokenEndpointAuthMethod;
  secret?: string;
}

interface Pending {
  identityId: string;
  spaceId: string;
  serverId: string;
  definitionVersion?: number;
  verifier: string;
  redirectUri: string;
  client: OAuthClient;
  resource: string;
  metadata: Metadata;
  expires: number;
  privateNetwork: boolean;
  label: string;
}

const TOKEN_AUTH_METHODS: readonly TokenEndpointAuthMethod[] = [
  'none',
  'client_secret_basic',
  'client_secret_post',
];

function tokenAuthMethod(value: unknown): TokenEndpointAuthMethod | null {
  return typeof value === 'string' && TOKEN_AUTH_METHODS.includes(value as TokenEndpointAuthMethod)
    ? value as TokenEndpointAuthMethod
    : null;
}

function registrationAuthMethod(metadata: Metadata): TokenEndpointAuthMethod {
  const supported = metadata.token_endpoint_auth_methods_supported;
  if (!supported?.length) return 'none';
  for (const method of TOKEN_AUTH_METHODS) if (supported.includes(method)) return method;
  throw new Error('OAuth client authentication unsupported');
}

/**
 * OAuth metadata may legitimately put authorization and token endpoints on a
 * different HTTPS origin (Figma uses www.figma.com and api.figma.com). Keep
 * that standard shape while refusing credentials/fragments and refusing a
 * cross-origin downgrade to HTTP. Same-origin HTTP remains available only for
 * an explicitly approved private-network connector.
 */
function oauthEndpoint(value: string, issuer: URL, privateNetwork: boolean, error: string): URL {
  let parsed: URL;
  try { parsed = new URL(value); }
  // Truncated: the endpoint is provider-supplied metadata, so a hostile
  // provider must not get to choose the length of a message tm8 renders.
  catch { throw oauthError(`${error}: ${value.slice(0, 120)} is not a valid URL.`); }
  const safeProtocol = parsed.protocol === 'https:'
    || (privateNetwork && parsed.protocol === 'http:' && parsed.origin === issuer.origin);
  if (!safeProtocol || parsed.username || parsed.password || parsed.hash) {
    throw oauthError(`${error}: ${parsed.origin} must be HTTPS without credentials or a fragment (same-origin HTTP is allowed only for an approved private-network connector).`);
  }
  return parsed;
}

/**
 * A preregistered confidential client authenticates with whichever secret method
 * the issuer advertises. Basic is the RFC 6749 default when none is listed;
 * Slack lists only client_secret_post.
 */
function preregisteredAuthMethod(metadata: Metadata): Exclude<TokenEndpointAuthMethod, 'none'> {
  const supported = metadata.token_endpoint_auth_methods_supported;
  if (!supported?.length || supported.includes('client_secret_basic')) return 'client_secret_basic';
  if (supported.includes('client_secret_post')) return 'client_secret_post';
  throw new Error('OAuth client authentication unsupported');
}

/**
 * Every failure below used to be a plain `Error`, which `toWireError` turns
 * into `internal server error` with the cause logged server-side only. A
 * member running `tm8 mcp oauth begin` therefore learned nothing about WHY the
 * connection failed, and the four real causes (not approved, loopback redirect
 * origin, no DCR support, issuer mismatch) look identical. These are
 * `CollabError`s so the sentence reaches the person who can fix it.
 *
 * Only the begin/callback flows — human sessions, by `requireHumanSession` —
 * raise these. The refresh and revoke paths run under an agent's proxy call
 * and keep their opaque messages: no vendor origin crosses into a harness
 * (ADR 0297).
 */
function oauthError(message: string, code: 'invalid_input' | 'upstream_unavailable' = 'invalid_input'): CollabError {
  return new CollabError(code, message);
}
/** Provider error codes are short tokens (`invalid_grant`); descriptions are not echoed. */
function errorCode(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value) ? value : null;
}
function providerErrorCode(body: string): string | null {
  let value: { error?: unknown };
  try { value = JSON.parse(body) as typeof value; } catch { return null; }
  return errorCode(value.error);
}
/**
 * The redirect URI is the single most common reason a hosted provider refuses
 * tm8: with `TM8_PUBLIC_ORIGIN` unset the callback falls back to the bind
 * address, so the server asks Slack or Notion to redirect to a loopback
 * address and registration or the code exchange is rejected. Naming it is the
 * whole point — the status alone cannot be acted on.
 */
function redirectDiagnosis(callbackUrl: string): string {
  let url: URL;
  try { url = new URL(callbackUrl); } catch { return ` The tm8 redirect URI ${callbackUrl} is not a valid URL; set TM8_PUBLIC_ORIGIN.`; }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || /^127\./.test(host)) {
    return ` The tm8 redirect URI origin is ${url.origin}, a loopback address, which hosted providers refuse: set TM8_PUBLIC_ORIGIN to this server's public HTTPS origin and restart, then register ${url.origin}/mcp/oauth/callback with the provider.`;
  }
  if (url.protocol !== 'https:') return ` The tm8 redirect URI origin is ${url.origin}, which is not HTTPS; most providers require an HTTPS redirect.`;
  return ` Confirm ${url.href} is registered as a redirect URL with the provider.`;
}
function formComponent(value: string): string {
  return new URLSearchParams([['value', value]]).toString().slice('value='.length);
}

function clientHeaders(body: URLSearchParams, client: OAuthClient): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (client.method === 'client_secret_basic') {
    if (!client.secret) throw new Error('OAuth client authentication unavailable');
    headers.authorization = `Basic ${Buffer.from(`${formComponent(client.id)}:${formComponent(client.secret)}`).toString('base64')}`;
    return headers;
  }
  body.set('client_id', client.id);
  if (client.method === 'client_secret_post') {
    if (!client.secret) throw new Error('OAuth client authentication unavailable');
    body.set('client_secret', client.secret);
  }
  return headers;
}

function clientFromSecret(secret: McpOAuthSecret): OAuthClient {
  const method = secret.tokenEndpointAuthMethod ?? 'none';
  if (!TOKEN_AUTH_METHODS.includes(method)) throw new Error('OAuth client authentication unsupported');
  return { id: secret.clientId, method, ...(secret.clientSecret ? { secret: secret.clientSecret } : {}) };
}

export class McpOAuth {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly callbackUrl: string) {}

  async begin(input: {
    identityId: string;
    spaceId: string;
    serverId: string;
    definitionVersion?: number;
    resource: string;
    issuer?: string;
    clientId?: string;
    /** Secret of the preregistered clientId; read from server env by the caller. */
    clientSecret?: string;
    label?: string;
    scopes?: string[];
    allowPrivateNetwork: boolean;
  }): Promise<{ authorizationUrl: string; expiresAt: string }> {
    for (const [key, value] of this.pending) if (value.expires < Date.now()) this.pending.delete(key);
    if (this.pending.size >= 1000) throw oauthError('Too many pending MCP connections on this server; retry in a few minutes.', 'upstream_unavailable');

    let issuerText = input.issuer;
    if (!issuerText) {
      const resource = new URL(input.resource);
      let metadataUrl = new URL(`/.well-known/oauth-protected-resource${resource.pathname.replace(/\/$/, '')}`, resource.origin).href;
      const challenge = await mcpHttp({ url: input.resource, method: 'GET' }, input.allowPrivateNetwork);
      const advertised = /resource_metadata="([^"]+)"/.exec(challenge.headers['www-authenticate'] ?? '')?.[1];
      if (advertised) metadataUrl = new URL(advertised, resource).href;
      const resourceResponse = await mcpHttp({ url: metadataUrl, method: 'GET' }, input.allowPrivateNetwork);
      if (resourceResponse.status !== 200) throw oauthError(`OAuth resource discovery failed: ${new URL(metadataUrl).origin} returned ${resourceResponse.status} for the protected-resource metadata. Set the connector's issuer explicitly if the provider does not publish it.`, 'upstream_unavailable');
      let resourceMetadata: { resource?: string; authorization_servers?: unknown[] };
      try { resourceMetadata = JSON.parse(resourceResponse.body) as typeof resourceMetadata; }
      catch { throw oauthError('OAuth resource discovery failed: the protected-resource metadata was not JSON.', 'upstream_unavailable'); }
      if (resourceMetadata.resource !== input.resource
        || !Array.isArray(resourceMetadata.authorization_servers)
        || typeof resourceMetadata.authorization_servers[0] !== 'string') {
        throw oauthError(`OAuth resource binding mismatch: the provider's metadata declares resource ${typeof resourceMetadata.resource === 'string' ? resourceMetadata.resource : '(absent)'} and tm8 requested ${input.resource}; they must match exactly. Register the connector URL exactly as the provider advertises it.`);
      }
      issuerText = resourceMetadata.authorization_servers[0];
    }

    let issuer: URL;
    try { issuer = new URL(issuerText); }
    catch { throw oauthError(`OAuth issuer refused: ${issuerText} is not a valid URL.`); }
    const discovery = new URL(`/.well-known/oauth-authorization-server${issuer.pathname.replace(/\/$/, '')}`, issuer.origin);
    const response = await mcpHttp({ url: discovery.href, method: 'GET' }, input.allowPrivateNetwork);
    if (response.status !== 200) throw oauthError(`OAuth discovery failed: ${discovery.href} returned ${response.status}.`, 'upstream_unavailable');
    let metadata: Metadata;
    try { metadata = JSON.parse(response.body) as Metadata; }
    catch { throw oauthError(`OAuth discovery failed: ${discovery.href} did not return JSON metadata.`, 'upstream_unavailable'); }
    // Two distinct causes, one message until now. An issuer mismatch is a
    // connector misconfiguration the member can fix; missing S256 is a
    // provider that tm8 cannot use at all.
    if (metadata.issuer !== issuerText) {
      throw oauthError(`OAuth issuer mismatch: discovery at ${discovery.href} declares issuer ${typeof metadata.issuer === 'string' ? metadata.issuer : '(absent)'}, but the connector expects ${issuerText}. Set the connector's issuer to the value the provider declares.`);
    }
    if (!metadata.code_challenge_methods_supported?.includes('S256')) {
      throw oauthError(`OAuth PKCE unsupported: ${issuerText} does not advertise the S256 code challenge method, which tm8 requires.`);
    }

    oauthEndpoint(metadata.authorization_endpoint, issuer, input.allowPrivateNetwork, 'OAuth endpoint refused');
    oauthEndpoint(metadata.token_endpoint, issuer, input.allowPrivateNetwork, 'OAuth endpoint refused');
    if (metadata.revocation_endpoint) oauthEndpoint(metadata.revocation_endpoint, issuer, input.allowPrivateNetwork, 'OAuth endpoint refused');

    if (input.clientSecret && !input.clientId) throw new Error('OAuth client secret requires a client id');
    let client: OAuthClient = input.clientId && input.clientSecret
      ? { id: input.clientId, method: preregisteredAuthMethod(metadata), secret: input.clientSecret }
      : { id: input.clientId ?? '', method: 'none' };
    if (!input.clientId) {
      if (!metadata.registration_endpoint) {
        throw oauthError(`OAuth client registration unavailable: ${issuerText} publishes no registration_endpoint, so it does not support Dynamic Client Registration (Slack does not). Create an app with the provider, set its Client ID on the connector and the matching client secret in this server's environment.${redirectDiagnosis(this.callbackUrl)}`);
      }
      const endpoint = oauthEndpoint(metadata.registration_endpoint, issuer, input.allowPrivateNetwork, 'OAuth registration endpoint refused');
      const requestedMethod = registrationAuthMethod(metadata);
      const registered = await mcpHttp({
        url: endpoint.href,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'tm8',
          redirect_uris: [this.callbackUrl],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: requestedMethod,
        }),
      }, input.allowPrivateNetwork);
      const registrationCode = providerErrorCode(registered.body);
      if (registered.status === 403) {
        throw oauthError(`OAuth client registration rejected by provider: ${endpoint.origin} answered 403${registrationCode ? ` (${registrationCode})` : ''}. The provider allows only pre-approved clients (Figma does this): obtain a Client ID from the provider and set it on the connector.${redirectDiagnosis(this.callbackUrl)}`, 'upstream_unavailable');
      }
      if (registered.status !== 200 && registered.status !== 201) {
        throw oauthError(`OAuth client registration failed: ${endpoint.origin} answered ${registered.status}${registrationCode ? ` (${registrationCode})` : ''}.${redirectDiagnosis(this.callbackUrl)}`, 'upstream_unavailable');
      }
      let value: { client_id?: unknown; token_endpoint_auth_method?: unknown; client_secret?: unknown };
      try { value = JSON.parse(registered.body) as typeof value; }
      catch { throw oauthError('OAuth client registration failed: the provider did not return JSON.', 'upstream_unavailable'); }
      const method = value.token_endpoint_auth_method === undefined
        ? requestedMethod
        : tokenAuthMethod(value.token_endpoint_auth_method);
      const secret = typeof value.client_secret === 'string' && value.client_secret ? value.client_secret : undefined;
      if (typeof value.client_id !== 'string' || !value.client_id || !method
        || (method === 'none' ? secret !== undefined : secret === undefined)) {
        throw oauthError('OAuth client registration unsupported: the provider returned a client tm8 cannot authenticate with (missing client_id, or a secret that contradicts the token endpoint auth method).', 'upstream_unavailable');
      }
      client = { id: value.client_id, method, ...(secret ? { secret } : {}) };
    }

    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const expires = Date.now() + 10 * 60 * 1000;
    this.pending.set(state, {
      identityId: input.identityId,
      spaceId: input.spaceId,
      serverId: input.serverId,
      definitionVersion: input.definitionVersion,
      resource: input.resource,
      client,
      metadata,
      verifier,
      redirectUri: this.callbackUrl,
      expires,
      privateNetwork: input.allowPrivateNetwork,
      label: input.label ?? 'OAuth account',
    });
    const url = new URL(metadata.authorization_endpoint);
    const params = {
      response_type: 'code',
      client_id: client.id,
      redirect_uri: this.callbackUrl,
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource: input.resource,
      scope: (input.scopes ?? []).join(' '),
    };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return { authorizationUrl: url.href, expiresAt: new Date(expires).toISOString() };
  }

  pendingFor(identityId: string, state: string): { serverId: string; definitionVersion?: number } | null {
    const pending = this.pending.get(state);
    if (!pending || pending.identityId !== identityId || pending.expires < Date.now()) return null;
    return { serverId: pending.serverId, definitionVersion: pending.definitionVersion };
  }

  async callback(identityId: string, input: { state: string; code?: string; issuer?: string; error?: string }): Promise<{ spaceId: string; serverId: string; label: string; secret: McpOAuthSecret }> {
    const pending = this.pending.get(input.state);
    if (!pending || pending.identityId !== identityId || pending.expires < Date.now()) {
      // Pending state is in memory: a server restart between begin and
      // callback loses it, and so does crossing the 10 minute window.
      throw oauthError('OAuth state invalid or expired: authorization must complete within 10 minutes, in the same browser identity that started it, and does not survive a tm8 server restart. Start the connection again.');
    }
    this.pending.delete(input.state); // one use even on provider failure
    if (input.error || !input.code) {
      // The callback's `error` is whatever reached the redirect: echo it only
      // when it is a short OAuth code, never as free text.
      const denial = errorCode(input.error);
      throw oauthError(`OAuth authorization denied by the provider${denial ? `: ${denial}` : ' (no authorization code was returned)'}.${denial === 'access_denied' ? ' The account holder declined the consent screen.' : redirectDiagnosis(pending.redirectUri)}`);
    }
    if (input.issuer !== undefined && input.issuer !== pending.metadata.issuer) {
      throw oauthError(`OAuth issuer mismatch: the callback named issuer ${input.issuer}, but authorization started against ${pending.metadata.issuer}.`);
    }
    const token = await tokenRequest(pending.metadata.token_endpoint, new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: pending.verifier,
      redirect_uri: pending.redirectUri,
      resource: pending.resource,
    }), pending.privateNetwork, pending.client, (status, code) => oauthError(
      `OAuth token exchange failed: ${new URL(pending.metadata.token_endpoint).origin} answered ${status}${code ? ` (${code})` : ''}.${code === 'invalid_grant' || code === 'invalid_request' ? redirectDiagnosis(pending.redirectUri) : ''}`,
      'upstream_unavailable'));
    return {
      spaceId: pending.spaceId,
      serverId: pending.serverId,
      label: pending.label,
      secret: {
        kind: 'oauth',
        ...token,
        issuer: pending.metadata.issuer,
        tokenEndpoint: pending.metadata.token_endpoint,
        resource: pending.resource,
        clientId: pending.client.id,
        tokenEndpointAuthMethod: pending.client.method,
        ...(pending.client.secret ? { clientSecret: pending.client.secret } : {}),
        ...(pending.metadata.revocation_endpoint ? { revocationEndpoint: pending.metadata.revocation_endpoint } : {}),
      },
    };
  }
}

/**
 * Token types that are sent as `Authorization: Bearer`. Slack's
 * oauth.v2.user.access, the token endpoint of its MCP server, labels its user
 * token `"token_type": "user"`; the MCP server's 401 challenges with
 * `WWW-Authenticate: Bearer`, so that is how the token is presented.
 * Anything else (DPoP, MAC) is refused rather than sent the wrong way.
 */
const BEARER_TOKEN_TYPES = new Set(['bearer', 'user']);

async function tokenRequest(
  url: string,
  body: URLSearchParams,
  privateNetwork: boolean,
  client: OAuthClient,
  /** Only the human begin/callback flow diagnoses the cause; refresh keeps its opaque message. */
  failure?: (status: number, code: string | null) => Error,
): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number }> {
  const response = await mcpHttp({ url, method: 'POST', headers: clientHeaders(body, client), body: body.toString() }, privateNetwork);
  if (response.status !== 200) throw failure ? failure(response.status, providerErrorCode(response.body)) : new Error('OAuth token exchange failed');
  let value: Record<string, unknown>;
  try { value = JSON.parse(response.body) as Record<string, unknown>; }
  catch { throw new Error('OAuth token exchange failed'); }
  if (typeof value.access_token !== 'string' || !value.access_token
    || typeof value.token_type !== 'string' || !BEARER_TOKEN_TYPES.has(value.token_type.toLowerCase())) {
    throw new Error('OAuth token response invalid');
  }
  return {
    accessToken: value.access_token,
    ...(typeof value.refresh_token === 'string' ? { refreshToken: value.refresh_token } : {}),
    ...(typeof value.expires_in === 'number' ? { expiresAt: Date.now() + value.expires_in * 1000 } : {}),
  };
}

export async function refreshOAuth(secret: McpOAuthSecret, privateNetwork: boolean): Promise<McpOAuthSecret> {
  if (!secret.refreshToken) throw new Error('MCP OAuth account requires reconnect');
  const token = await tokenRequest(secret.tokenEndpoint, new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: secret.refreshToken,
    resource: secret.resource,
  }), privateNetwork, clientFromSecret(secret));
  return { ...secret, ...token };
}

/** Local revocation must commit before calling this best-effort provider cleanup. */
export async function revokeOAuth(secret: McpOAuthSecret, privateNetwork: boolean): Promise<boolean> {
  if (!secret.revocationEndpoint) return false;
  const client = clientFromSecret(secret);
  for (const [token, hint] of [[secret.refreshToken, 'refresh_token'], [secret.accessToken, 'access_token']] as const) {
    if (!token) continue;
    const body = new URLSearchParams({ token, token_type_hint: hint });
    const response = await mcpHttp({
      url: secret.revocationEndpoint,
      method: 'POST',
      headers: clientHeaders(body, client),
      body: body.toString(),
    }, privateNetwork);
    if (response.status !== 200) return false;
  }
  return true;
}
