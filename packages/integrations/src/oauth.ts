import { createHash, randomBytes } from 'node:crypto';
type McpCredentialScope = 'member' | 'space';
export interface OAuthIdentity { readonly identityId?: string }

import type { IntegrationKeyProvider as KeyProvider } from './credentials.js';
import { openSecret, sealSecret, type OAuthPendingSecretBinding } from './secret-box.js';
import { mcpHttp } from './transport.js';
import { readOAuthToken } from './oauth-token.js';
import type { McpOAuthSecret } from './credentials.js';

type TokenEndpointAuthMethod = 'none' | 'client_secret_basic' | 'client_secret_post';

export interface Metadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  code_challenge_methods_supported?: string[];
  response_types_supported?: string[];
  registration_endpoint?: string;
  revocation_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
}

export interface OAuthClient {
  id: string;
  method: TokenEndpointAuthMethod;
  secret?: string;
}

/**
 * What the code exchange trusts, sealed into one envelope (§5.4). The token
 * endpoint is in `metadata`, so it is sealed too: a writer of the pending table
 * cannot send the code and verifier anywhere else.
 */
interface SealedPending {
  verifier: string;
  redirectUri: string;
  client: OAuthClient;
  resource: string;
  metadata: Metadata;
  requestedScopes?: string[];
  privateNetwork: boolean;
  /**
   * A first-party connect (§8.1, Google). Sealed, so a writer of the pending
   * table cannot turn it on or off: the code exchange then sends no RFC 8707
   * `resource`, and the client secret — server configuration — is neither
   * sealed here nor copied into the connection. The callback reads it from
   * configuration again, and the host refreshes with it.
   */
  firstParty?: true;
}

/**
 * How a first-party host connects (§8.1): static endpoints and the node's own
 * preregistered client, so begin does no discovery and no registration, and
 * extra authorization parameters the provider needs (Google's offline access).
 */
export interface McpFirstPartyAuthorization {
  metadata: Metadata;
  client: OAuthClient;
  scopes: string[];
  authorizeParams: Readonly<Record<string, string>>;
  privateNetwork: boolean;
}

interface PendingInput {
  spaceId: string;
  serverId: string;
  definitionVersion?: number;
  resource: string;
  label?: string;
  scopes?: string[];
  scope?: McpCredentialScope;
  returnTo?: string;
}

/** A row of `internal.mcp_oauth_pending` as begin writes it (migration 342). */
export interface McpOAuthPendingRow {
  stateHash: Buffer;
  spaceId: string;
  serverId: string;
  definitionVersion?: number;
  scope: McpCredentialScope;
  keyId: string;
  ciphertext: Buffer;
  nonce: Buffer;
  label: string;
  returnTo?: string;
  expiresAt: Date;
}

/** The consumed row, as `take_mcp_oauth_pending` returns it. */
export interface McpOAuthPendingTaken {
  identityId: string;
  spaceId: string;
  serverId: string;
  definitionVersion: number | null;
  scope: McpCredentialScope;
  keyId: string;
  ciphertext: string;
  nonce: string;
  label: string;
  returnTo: string | null;
  expiresAt: string;
}

/**
 * Where pending sign-ins live. Production is Postgres, so a connect survives a
 * restart and works across instances (G1). `take` is single-use: it consumes
 * the caller's own row, or returns null and consumes nothing of anyone else's.
 */
export interface McpOAuthPendingStore<Claims extends OAuthIdentity = OAuthIdentity> {
  /** Returns the expiry actually stored. */
  insert(claims: Claims, row: McpOAuthPendingRow): Promise<string>;
  take(claims: Claims, stateHash: Buffer): Promise<McpOAuthPendingTaken | null>;
}

/** The connector a consumed sign-in belongs to, before its code is exchanged. */
export interface McpOAuthPendingTarget {
  spaceId: string;
  serverId: string;
  definitionVersion?: number;
  scope: McpCredentialScope;
}

export interface McpOAuthCallbackResult extends McpOAuthPendingTarget {
  label: string;
  returnTo?: string;
  /** The `scope` of the provider's token response, when it sends one. */
  grantedScopes?: string[];
  secret: McpOAuthSecret;
}

const PENDING_TTL_MS = 10 * 60 * 1000;

function stateHash(state: string): Buffer {
  return createHash('sha256').update(state).digest();
}

function pendingBinding(keyId: string, hash: Buffer, identityId: string, row: {
  spaceId: string; serverId: string; scope: string; definitionVersion?: number | null; returnTo?: string | null;
}): OAuthPendingSecretBinding {
  return {
    keyId, stateHash: hash.toString('hex'), identityId, spaceId: row.spaceId.toLowerCase(), serverId: row.serverId.toLowerCase(), scope: row.scope,
    definitionVersion: row.definitionVersion ?? null, returnTo: row.returnTo || null,
  };
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
 * Every begin/callback failure used to be a plain `Error`, which `toWireError`
 * turns into `internal server error` with the cause logged server-side only, so
 * a member learned nothing about WHY a connection failed. These are
 * `CollabError`s so the sentence reaches the person who can fix it.
 *
 * Only the begin/callback flows (human sessions, by `requireHumanSession`)
 * raise these. The refresh and revoke paths run under an agent's proxy call and
 * keep their opaque messages: no vendor origin crosses into a harness
 * (ADR 0297). Ported from #1296 onto the Postgres pending state (#1315).
 */
export class IntegrationOAuthError extends Error {
  constructor(readonly code: 'invalid_input' | 'upstream_unavailable', message: string) { super(message); this.name = 'IntegrationOAuthError'; }
}
function oauthError(message: string, code: 'invalid_input' | 'upstream_unavailable' = 'invalid_input'): IntegrationOAuthError {
  return new IntegrationOAuthError(code, message);
}
/** Provider error codes are short tokens (`invalid_grant`); descriptions are never echoed. */
function errorCode(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value) ? value : null;
}
function providerErrorCode(body: string): string | null {
  let value: { error?: unknown };
  try { value = JSON.parse(body) as typeof value; } catch { return null; }
  return errorCode(value?.error);
}
/**
 * The redirect URI is the most common reason a hosted provider refuses tm8:
 * with `TM8_PUBLIC_ORIGIN` unset the callback falls back to the bind address,
 * so the server asks Slack or Notion to redirect to a loopback address and
 * registration or the code exchange is rejected. The status alone cannot be
 * acted on; naming the origin can.
 */
function redirectDiagnosis(callbackUrl: string): string {
  let url: URL;
  try { url = new URL(callbackUrl); } catch { return ` The tm8 redirect URI ${callbackUrl} is not a valid URL; set TM8_PUBLIC_ORIGIN.`; }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || /^127\./.test(host)) {
    return ` The tm8 redirect URI origin is ${url.origin}, a loopback address. Confirm the provider accepts this redirect; otherwise set TM8_PUBLIC_ORIGIN to this server's public HTTPS origin and restart, then register ${url.origin}/mcp/oauth/callback with the provider.`;
  }
  if (url.protocol !== 'https:') return ` The tm8 redirect URI origin is ${url.origin}, which is not HTTPS; most providers require an HTTPS redirect.`;
  return ` Confirm ${url.href} is registered as a redirect URL with the provider.`;
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

function formComponent(value: string): string {
  return new URLSearchParams([['value', value]]).toString().slice('value='.length);
}

function clientHeaders(body: URLSearchParams, client: OAuthClient): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
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

export interface OAuthDiscoveryInput { resource: string; issuer?: string; allowPrivateNetwork: boolean }

/** Public metadata only: does not register a client or authorize an account. */
export async function discoverOAuth(input: OAuthDiscoveryInput): Promise<Metadata> {
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
    // Two distinct causes: an issuer mismatch is a connector misconfiguration
    // the member can fix; missing S256 is a provider tm8 cannot use at all.
    if (metadata.issuer !== issuerText) {
      throw oauthError(`OAuth issuer mismatch: discovery at ${discovery.href} declares issuer ${typeof metadata.issuer === 'string' ? metadata.issuer : '(absent)'}, but the connector expects ${issuerText}. Set the connector's issuer to the value the provider declares.`);
    }
    if (!metadata.code_challenge_methods_supported?.includes('S256')) {
      throw oauthError(`OAuth PKCE unsupported: ${issuerText} does not advertise the S256 code challenge method, which tm8 requires.`);
    }

    oauthEndpoint(metadata.authorization_endpoint, issuer, input.allowPrivateNetwork, 'OAuth endpoint refused');
    oauthEndpoint(metadata.token_endpoint, issuer, input.allowPrivateNetwork, 'OAuth endpoint refused');
    if (metadata.revocation_endpoint) oauthEndpoint(metadata.revocation_endpoint, issuer, input.allowPrivateNetwork, 'OAuth endpoint refused');

    return metadata;
}

export class McpOAuth<Claims extends OAuthIdentity = OAuthIdentity> {
  constructor(
    private readonly callbackUrl: string,
    private readonly pending: McpOAuthPendingStore<Claims>,
    private readonly keys: KeyProvider,
  ) {}

  async begin(claims: Claims, input: {
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
    /** Who will own the connection: "Just me" or "Shared with this Space" (§10.2). */
    scope?: McpCredentialScope;
    /** Same-origin path a same-tab sign-in returns to (§10.2 popup-blocked row). */
    returnTo?: string;
    allowPrivateNetwork: boolean;
  }): Promise<{ authorizationUrl: string; expiresAt: string }> {
    const identityId = claims.identityId;
    if (!identityId) throw new Error('OAuth requires a signed-in member');

    const metadata = await discoverOAuth(input);
    const issuerText = metadata.issuer;
    const issuer = new URL(issuerText);

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
      const secret = method !== 'none' && typeof value.client_secret === 'string' && value.client_secret ? value.client_secret : undefined;
      if (typeof value.client_id !== 'string' || !value.client_id || !method
        || (method !== 'none' && secret === undefined)) {
        throw oauthError('OAuth client registration unsupported: the provider returned a client tm8 cannot authenticate with (missing client_id, or a secret that contradicts the token endpoint auth method).', 'upstream_unavailable');
      }
      client = { id: value.client_id, method, ...(secret ? { secret } : {}) };
    }

    return this.start(claims, identityId, input, { redirectUri: this.callbackUrl, client, resource: input.resource, metadata, privateNetwork: input.allowPrivateNetwork }, { resource: input.resource });
  }

  /**
   * Begin for a first-party connector (§8.1): the provider's static endpoints
   * and the node's client, with the SAME pending row, PKCE and single-use state
   * as every other connect, so the shared `/mcp/oauth/callback` completes it.
   */
  async beginFirstParty(claims: Claims, input: Omit<PendingInput, 'scopes'>, provider: McpFirstPartyAuthorization): Promise<{ authorizationUrl: string; expiresAt: string }> {
    const identityId = claims.identityId;
    if (!identityId) throw new Error('OAuth requires a signed-in member');
    if (!provider.client.secret || provider.client.method === 'none') throw new Error('OAuth client authentication unavailable');
    if (!provider.metadata.code_challenge_methods_supported?.includes('S256')) throw new Error('OAuth issuer or PKCE unsupported');
    return this.start(claims, identityId, { ...input, scopes: provider.scopes }, {
      redirectUri: this.callbackUrl, client: { id: provider.client.id, method: provider.client.method }, resource: input.resource, metadata: provider.metadata,
      privateNetwork: provider.privateNetwork, firstParty: true,
    }, provider.authorizeParams);
  }

  private async start(claims: Claims, identityId: string, input: PendingInput, pending: Omit<SealedPending, 'verifier'>, extraParams: Readonly<Record<string, string>>): Promise<{ authorizationUrl: string; expiresAt: string }> {
    const { metadata, client } = pending;
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const hash = stateHash(state);
    const scope = input.scope ?? 'member';
    const keyId = this.keys.activeKeyId;
    const sealed: SealedPending = { ...pending, verifier, ...(input.scopes ? { requestedScopes: input.scopes } : {}) };
    const envelope = sealSecret(await this.keys.keyFor(keyId), JSON.stringify(sealed), pendingBinding(keyId, hash, identityId, { ...input, scope }));
    const expiresAt = await this.pending.insert(claims, {
      stateHash: hash,
      spaceId: input.spaceId,
      serverId: input.serverId,
      ...(input.definitionVersion !== undefined ? { definitionVersion: input.definitionVersion } : {}),
      scope,
      keyId,
      ciphertext: envelope.ciphertext,
      nonce: envelope.nonce,
      label: input.label ?? 'OAuth account',
      ...(input.returnTo ? { returnTo: input.returnTo } : {}),
      expiresAt: new Date(Date.now() + PENDING_TTL_MS),
    });
    const url = new URL(metadata.authorization_endpoint);
    // The provider's extra parameters go FIRST, so none of them can replace the
    // state, the PKCE challenge, the client or the redirect below.
    const params = {
      ...extraParams,
      response_type: 'code',
      client_id: client.id,
      redirect_uri: this.callbackUrl,
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      scope: (input.scopes ?? []).join(' '),
    };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return { authorizationUrl: url.href, expiresAt };
  }

  /**
   * Consumes the state FIRST, so it is spent even when the provider, the guard
   * or the exchange then fails (§5.4). `guard` sees the connector before any
   * code leaves the server; the handler uses it to refuse a changed definition.
   */
  async callback(
    claims: Claims,
    input: { state: string; code?: string; issuer?: string; error?: string },
    guard?: (target: McpOAuthPendingTarget) => Promise<void>,
    /** A first-party connect's client, from server configuration now (the pending row holds no secret). */
    firstPartyClient?: (resource: string) => OAuthClient,
  ): Promise<McpOAuthCallbackResult> {
    const identityId = claims.identityId;
    if (!identityId) throw new Error('OAuth state invalid or expired');
    const hash = stateHash(input.state);
    const taken = await this.pending.take(claims, hash);
    // The database refuses an expired row on its own clock; this is the server's.
    if (!taken || taken.identityId !== identityId || Date.parse(taken.expiresAt) < Date.now()) throw oauthError('OAuth state invalid or expired: authorization must complete within 10 minutes, as the same signed-in member who started it. Start the connection again.');
    let pending: SealedPending;
    try {
      pending = JSON.parse(openSecret(
        await this.keys.keyFor(taken.keyId),
        { ciphertext: Buffer.from(taken.ciphertext, 'base64'), nonce: Buffer.from(taken.nonce, 'base64') },
        pendingBinding(taken.keyId, hash, identityId, taken),
      )) as SealedPending;
    } catch { throw new Error('OAuth state invalid or expired'); }
    const target: McpOAuthPendingTarget = {
      spaceId: taken.spaceId, serverId: taken.serverId, scope: taken.scope,
      ...(taken.definitionVersion !== null ? { definitionVersion: taken.definitionVersion } : {}),
    };
    if (guard) await guard(target);
    if (input.error || !input.code) {
      // The callback's `error` is whatever reached the redirect: echo it only
      // when it is a short OAuth code, never as free text.
      const denial = errorCode(input.error);
      throw oauthError(`OAuth authorization denied by the provider${denial ? `: ${denial}` : ' (no authorization code was returned)'}.${denial === 'access_denied' ? ' The account holder declined the consent screen.' : redirectDiagnosis(pending.redirectUri)}`);
    }
    if (input.issuer !== undefined && input.issuer !== pending.metadata.issuer) {
      throw oauthError(`OAuth issuer mismatch: the callback named issuer ${input.issuer}, but authorization started against ${pending.metadata.issuer}.`);
    }
    let client = pending.client;
    if (pending.firstParty) {
      if (!firstPartyClient) throw new Error('OAuth client authentication unavailable');
      client = firstPartyClient(pending.resource);
      // The code was issued to the client sealed at begin; a node reconfigured
      // in between would be refused by the provider anyway, so say why here.
      if (client.id !== pending.client.id || !client.secret) throw new Error('OAuth client changed; restart authorization');
    }
    const { scope: grantedScope, ...token } = await tokenRequest(pending.metadata.token_endpoint, new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: pending.verifier,
      redirect_uri: pending.redirectUri,
      ...(pending.firstParty ? {} : { resource: pending.resource }),
    }), pending.privateNetwork, client, (status, code) => oauthError(
      `OAuth token exchange failed: ${new URL(pending.metadata.token_endpoint).origin} answered ${status}${code ? ` (${code})` : ''}.${code === 'invalid_grant' || code === 'invalid_request' ? redirectDiagnosis(pending.redirectUri) : ''}`,
      'upstream_unavailable'));
    // RFC 6749 §5.1: an omitted scope is the requested grant, not an empty grant.
    const grantedScopes = grantedScope === undefined ? pending.requestedScopes : grantedScope.split(' ').filter(Boolean);
    return {
      ...target,
      label: taken.label,
      ...(taken.returnTo ? { returnTo: taken.returnTo } : {}),
      ...(grantedScopes?.length ? { grantedScopes } : {}),
      secret: {
        kind: 'oauth',
        ...token,
        issuer: pending.metadata.issuer,
        tokenEndpoint: pending.metadata.token_endpoint,
        resource: pending.resource,
        clientId: pending.client.id,
        tokenEndpointAuthMethod: pending.client.method,
        ...(pending.client.secret && !pending.firstParty ? { clientSecret: pending.client.secret } : {}),
        ...(pending.metadata.revocation_endpoint ? { revocationEndpoint: pending.metadata.revocation_endpoint } : {}),
        ...(pending.firstParty && grantedScopes ? { grantedScopes } : {}),
      },
    };
  }
}

/**
 * A token endpoint refused the request. The message is the one every caller
 * already shows; `oauthError` is the RFC 6749 §5.2 `error` the provider sent,
 * when it sent one (not `code`: the database layer reads that as a SQLSTATE), so a refresh can tell a dead grant (`invalid_grant`, §7.2) from a
 * provider or network hiccup, which must never mark a connection.
 */
export class OAuthTokenError extends Error {
  constructor(readonly oauthError: string | undefined) { super('OAuth token exchange failed'); }
}

/** The RFC 6749 `error` code of a refused token request, or undefined. Never its description. */
export function oauthErrorCode(body: string): string | undefined {
  return providerErrorCode(body) ?? undefined;
}

/**
 * Token types that are sent as `Authorization: Bearer`. Slack's
 * oauth.v2.user.access, the token endpoint of its MCP server, labels its user
 * token `"token_type": "user"`; the MCP server's 401 challenges with
 * `WWW-Authenticate: Bearer`, so that is how the token is presented.
 * Anything else (DPoP, MAC) is refused rather than sent the wrong way.
 */

async function tokenRequest(
  url: string,
  body: URLSearchParams,
  privateNetwork: boolean,
  client: OAuthClient,
  /** Only the human callback flow diagnoses the cause; refresh keeps its opaque message (ADR 0297). */
  failure?: (status: number, code: string | null) => Error,
): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number; scope?: string }> {
  const response = await mcpHttp({ url, method: 'POST', headers: clientHeaders(body, client), body: body.toString() }, privateNetwork);
  // The callback flow words the cause itself; a refresh carries only the
  // provider's short code, so it can tell invalid_grant (§7.2) from a hiccup.
  if (response.status !== 200) throw failure ? failure(response.status, providerErrorCode(response.body)) : new OAuthTokenError(oauthErrorCode(response.body));
  let value: Record<string, unknown>;
  try { value = JSON.parse(response.body) as Record<string, unknown>; }
  catch { throw new Error('OAuth token exchange failed'); }
  return readOAuthToken(value, url);
}

export async function refreshOAuth(secret: McpOAuthSecret, privateNetwork: boolean): Promise<McpOAuthSecret> {
  if (!secret.refreshToken) throw new Error('MCP OAuth account requires reconnect');
  const token = await tokenRequest(secret.tokenEndpoint, new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: secret.refreshToken,
    resource: secret.resource,
  }), privateNetwork, clientFromSecret(secret));
  // The granted scope is not part of the sealed secret; refresh_mcp_credential has no column for it.
  const { scope: _scope, ...rotated } = token;
  return { ...secret, ...rotated };
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
