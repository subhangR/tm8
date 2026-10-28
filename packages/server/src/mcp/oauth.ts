import { createHash, randomBytes } from 'node:crypto';
import type { McpCredentialScope } from '@tm8/contract';
import type { Db, DbClaims } from '../db/types.js';
import type { KeyProvider } from '../credentials/key-provider.js';
import { openSecret, sealSecret, type OAuthPendingSecretBinding } from '../credentials/secret-box.js';
import { mcpHttp } from './transport.js';
import type { McpOAuthSecret } from './credential-store.js';

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
export interface McpOAuthPendingStore {
  /** Returns the expiry actually stored. */
  insert(claims: DbClaims, row: McpOAuthPendingRow): Promise<string>;
  take(claims: DbClaims, stateHash: Buffer): Promise<McpOAuthPendingTaken | null>;
}

export class DbMcpOAuthPendingStore implements McpOAuthPendingStore {
  constructor(private readonly db: Db) {}
  async insert(claims: DbClaims, row: McpOAuthPendingRow): Promise<string> {
    const stored = await this.db.rpc<string | Date>(claims, 'create_mcp_oauth_pending', [
      row.stateHash, row.spaceId, row.serverId, row.definitionVersion ?? null, row.scope, row.keyId,
      row.ciphertext, row.nonce, row.label, row.returnTo ?? null, row.expiresAt.toISOString(),
    ]);
    return new Date(stored).toISOString();
  }
  take(claims: DbClaims, stateHash: Buffer): Promise<McpOAuthPendingTaken | null> {
    return this.db.rpc<McpOAuthPendingTaken | null>(claims, 'take_mcp_oauth_pending', [stateHash]);
  }
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
  catch { throw new Error(error); }
  const safeProtocol = parsed.protocol === 'https:'
    || (privateNetwork && parsed.protocol === 'http:' && parsed.origin === issuer.origin);
  if (!safeProtocol || parsed.username || parsed.password || parsed.hash) throw new Error(error);
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
  constructor(
    private readonly callbackUrl: string,
    private readonly pending: McpOAuthPendingStore,
    private readonly keys: KeyProvider,
  ) {}

  async begin(claims: DbClaims, input: {
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

    let issuerText = input.issuer;
    if (!issuerText) {
      const resource = new URL(input.resource);
      let metadataUrl = new URL(`/.well-known/oauth-protected-resource${resource.pathname.replace(/\/$/, '')}`, resource.origin).href;
      const challenge = await mcpHttp({ url: input.resource, method: 'GET' }, input.allowPrivateNetwork);
      const advertised = /resource_metadata="([^"]+)"/.exec(challenge.headers['www-authenticate'] ?? '')?.[1];
      if (advertised) metadataUrl = new URL(advertised, resource).href;
      const resourceResponse = await mcpHttp({ url: metadataUrl, method: 'GET' }, input.allowPrivateNetwork);
      if (resourceResponse.status !== 200) throw new Error('OAuth resource discovery failed');
      let resourceMetadata: { resource?: string; authorization_servers?: unknown[] };
      try { resourceMetadata = JSON.parse(resourceResponse.body) as typeof resourceMetadata; }
      catch { throw new Error('OAuth resource discovery failed'); }
      if (resourceMetadata.resource !== input.resource
        || !Array.isArray(resourceMetadata.authorization_servers)
        || typeof resourceMetadata.authorization_servers[0] !== 'string') {
        throw new Error('OAuth resource binding mismatch');
      }
      issuerText = resourceMetadata.authorization_servers[0];
    }

    let issuer: URL;
    try { issuer = new URL(issuerText); }
    catch { throw new Error('OAuth issuer refused'); }
    const discovery = new URL(`/.well-known/oauth-authorization-server${issuer.pathname.replace(/\/$/, '')}`, issuer.origin);
    const response = await mcpHttp({ url: discovery.href, method: 'GET' }, input.allowPrivateNetwork);
    if (response.status !== 200) throw new Error('OAuth discovery failed');
    let metadata: Metadata;
    try { metadata = JSON.parse(response.body) as Metadata; }
    catch { throw new Error('OAuth discovery failed'); }
    if (metadata.issuer !== issuerText || !metadata.code_challenge_methods_supported?.includes('S256')) {
      throw new Error('OAuth issuer or PKCE unsupported');
    }

    oauthEndpoint(metadata.authorization_endpoint, issuer, input.allowPrivateNetwork, 'OAuth endpoint refused');
    oauthEndpoint(metadata.token_endpoint, issuer, input.allowPrivateNetwork, 'OAuth endpoint refused');
    if (metadata.revocation_endpoint) oauthEndpoint(metadata.revocation_endpoint, issuer, input.allowPrivateNetwork, 'OAuth endpoint refused');

    if (input.clientSecret && !input.clientId) throw new Error('OAuth client secret requires a client id');
    let client: OAuthClient = input.clientId && input.clientSecret
      ? { id: input.clientId, method: preregisteredAuthMethod(metadata), secret: input.clientSecret }
      : { id: input.clientId ?? '', method: 'none' };
    if (!input.clientId) {
      if (!metadata.registration_endpoint) throw new Error('OAuth client registration required');
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
      if (registered.status === 403) throw new Error('OAuth client registration rejected by provider');
      if (registered.status !== 200 && registered.status !== 201) throw new Error('OAuth client registration failed');
      let value: { client_id?: unknown; token_endpoint_auth_method?: unknown; client_secret?: unknown };
      try { value = JSON.parse(registered.body) as typeof value; }
      catch { throw new Error('OAuth client registration failed'); }
      const method = value.token_endpoint_auth_method === undefined
        ? requestedMethod
        : tokenAuthMethod(value.token_endpoint_auth_method);
      const secret = typeof value.client_secret === 'string' && value.client_secret ? value.client_secret : undefined;
      if (typeof value.client_id !== 'string' || !value.client_id || !method
        || (method === 'none' ? secret !== undefined : secret === undefined)) {
        throw new Error('OAuth client registration unsupported');
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
  async beginFirstParty(claims: DbClaims, input: Omit<PendingInput, 'scopes'>, provider: McpFirstPartyAuthorization): Promise<{ authorizationUrl: string; expiresAt: string }> {
    const identityId = claims.identityId;
    if (!identityId) throw new Error('OAuth requires a signed-in member');
    if (!provider.client.secret || provider.client.method === 'none') throw new Error('OAuth client authentication unavailable');
    if (!provider.metadata.code_challenge_methods_supported?.includes('S256')) throw new Error('OAuth issuer or PKCE unsupported');
    return this.start(claims, identityId, { ...input, scopes: provider.scopes }, {
      redirectUri: this.callbackUrl, client: { id: provider.client.id, method: provider.client.method }, resource: input.resource, metadata: provider.metadata,
      privateNetwork: provider.privateNetwork, firstParty: true,
    }, provider.authorizeParams);
  }

  private async start(claims: DbClaims, identityId: string, input: PendingInput, pending: Omit<SealedPending, 'verifier'>, extraParams: Readonly<Record<string, string>>): Promise<{ authorizationUrl: string; expiresAt: string }> {
    const { metadata, client } = pending;
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const hash = stateHash(state);
    const scope = input.scope ?? 'member';
    const keyId = this.keys.activeKeyId;
    const sealed: SealedPending = { ...pending, verifier };
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
    claims: DbClaims,
    input: { state: string; code?: string; issuer?: string; error?: string },
    guard?: (target: McpOAuthPendingTarget) => Promise<void>,
    /** A first-party connect's client, from server configuration now (the pending row holds no secret). */
    firstPartyClient?: () => OAuthClient,
  ): Promise<McpOAuthCallbackResult> {
    const identityId = claims.identityId;
    if (!identityId) throw new Error('OAuth state invalid or expired');
    const hash = stateHash(input.state);
    const taken = await this.pending.take(claims, hash);
    // The database refuses an expired row on its own clock; this is the server's.
    if (!taken || taken.identityId !== identityId || Date.parse(taken.expiresAt) < Date.now()) throw new Error('OAuth state invalid or expired');
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
    if (input.error || !input.code) throw new Error('OAuth authorization denied');
    if (input.issuer !== undefined && input.issuer !== pending.metadata.issuer) throw new Error('OAuth issuer mismatch');
    let client = pending.client;
    if (pending.firstParty) {
      if (!firstPartyClient) throw new Error('OAuth client authentication unavailable');
      client = firstPartyClient();
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
    }), pending.privateNetwork, client);
    const grantedScopes = grantedScope?.split(' ').filter(Boolean);
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
): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number; scope?: string }> {
  const response = await mcpHttp({ url, method: 'POST', headers: clientHeaders(body, client), body: body.toString() }, privateNetwork);
  if (response.status !== 200) throw new Error('OAuth token exchange failed');
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
    ...(typeof value.scope === 'string' ? { scope: value.scope } : {}),
  };
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
