import { googleFirstPartyService, type GoogleFirstPartyService, type McpUnavailableTool } from '@tm8/contract';
import type { McpOAuthSecret } from '../../credential-store.js';
import { OAuthTokenError, oauthErrorCode, type McpFirstPartyAuthorization, type OAuthClient } from '../../oauth.js';
import { mcpHttp } from '../../transport.js';
import { FirstPartyRefused, type FirstPartyConnection, type FirstPartyDefinition, type FirstPartyHost } from '../host.js';
import { GoogleApi, GoogleApiError, jsonSchema, type GoogleTool } from './api.js';
import { CALENDAR_TOOLS } from './calendar.js';
import { DRIVE_TOOLS } from './drive.js';
import { GOOGLE_ENDPOINTS, GOOGLE_NOT_CONFIGURED, type GoogleEndpoints, type GoogleHostOptions } from './endpoints.js';
import { GMAIL_TOOLS } from './gmail.js';

const TOOLS: Record<GoogleFirstPartyService['catalogId'], readonly GoogleTool[]> = {
  'google.gmail': GMAIL_TOOLS,
  'google.calendar': CALENDAR_TOOLS,
  'google.drive': DRIVE_TOOLS,
};

/**
 * Google's parameters for a connect (§8.1). `access_type=offline` is what makes
 * Google issue a refresh token, `prompt=consent` makes it issue one again on a
 * reconnect, and `include_granted_scopes=true` lets Calendar after Gmail ask
 * for the Calendar scopes alone on the same Google account.
 */
export const GOOGLE_AUTHORIZE_PARAMS: Readonly<Record<string, string>> = {
  access_type: 'offline',
  prompt: 'consent',
  include_granted_scopes: 'true',
};

/**
 * tm8's in-process Google host: Gmail, Calendar and Drive as MCP tools over the
 * Google REST APIs, called with the connection's own OAuth token.
 */
export class GoogleFirstPartyHost implements FirstPartyHost {
  readonly endpoints: GoogleEndpoints;
  private readonly privateNetwork: boolean;

  constructor(private readonly options: GoogleHostOptions) {
    this.endpoints = options.endpoints ?? GOOGLE_ENDPOINTS;
    this.privateNetwork = options.privateNetwork === true;
  }

  /**
   * The service a definition names. A first-party definition must carry a
   * Google catalog id AND that service's own URL: the URL is the identity the
   * connection was bound to, and the SQL catalog enforces the same pairing.
   */
  service(definition: FirstPartyDefinition): GoogleFirstPartyService {
    const service = googleFirstPartyService(definition.catalogId);
    if (definition.firstParty !== true || !service || definition.url !== service.resource) throw new FirstPartyRefused('MCP connector unavailable');
    return service;
  }

  /**
   * The tools a connection gets (§7.1: no tool a caller can't use). A gated
   * tool exists only while its gate is TRUE, and a tool exists only when the
   * connection was granted a scope that lets it work: Google's granular consent
   * lets a person untick a scope, and a connection with no reported scopes gets
   * nothing.
   */
  tools(definition: FirstPartyDefinition, grantedScopes: readonly string[] | undefined): readonly GoogleTool[] {
    const granted = new Set(googleScopesFor(this.service(definition), grantedScopes));
    return TOOLS[this.service(definition).catalogId]
      .filter(tool => (!tool.gate || definition.gates?.[tool.gate] === true) && tool.scopes.some(scope => granted.has(scope)));
  }

  /**
   * Whether a grant covers at least one of this connector's tools, gates aside.
   * A refresh that leaves none is scope_reduced (B41); a partial grant is not.
   */
  covers(definition: FirstPartyDefinition, grantedScopes: readonly string[] | undefined): boolean {
    const granted = new Set(googleScopesFor(this.service(definition), grantedScopes));
    return TOOLS[this.service(definition).catalogId].some(tool => tool.scopes.some(scope => granted.has(scope)));
  }

  scopesFor(definition: FirstPartyDefinition, grantedScopes: readonly string[] | undefined): string[] {
    return googleScopesFor(this.service(definition), grantedScopes);
  }

  /**
   * The tools this connection is MISSING for want of a scope — for the health
   * check only, never for a model's tool list. A gated-off tool is not missing:
   * it is switched off for everyone.
   */
  uncovered(definition: FirstPartyDefinition, grantedScopes: readonly string[] | undefined): McpUnavailableTool[] {
    const usable = new Set(this.tools(definition, grantedScopes).map(tool => tool.name));
    return TOOLS[this.service(definition).catalogId]
      .filter(tool => !usable.has(tool.name) && (!tool.gate || definition.gates?.[tool.gate] === true))
      .map(tool => ({ name: tool.name, unavailable: 'scope_missing', scopes: [...tool.scopes] }));
  }

  async request(definition: FirstPartyDefinition, method: 'tools/list' | 'tools/call', params: Record<string, unknown>, connection: FirstPartyConnection): Promise<unknown> {
    const tools = this.tools(definition, connection.grantedScopes);
    if (method === 'tools/list') {
      return { tools: tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: jsonSchema(tool.input), annotations: {readOnlyHint:tool.effect==='read',destructiveHint:tool.effect==='destructive',idempotentHint:tool.effect==='read',openWorldHint:true} })) };
    }
    const name = params.name;
    const tool = tools.find(candidate => candidate.name === name);
    if (!tool) {
      // A gated tool is not listed, and calling it by name is refused before any
      // request leaves the server — the gate is not a hint to the model.
      const known = TOOLS[this.service(definition).catalogId].find(candidate => candidate.name === name);
      if (!known) throw new Error('MCP tool unavailable');
      if (known.gate && definition.gates?.[known.gate] !== true) throw new Error(`MCP tool ${known.name} is turned off for this connector`);
      throw new Error(`MCP tool ${known.name} needs a Google permission this connection was not granted; reconnect and allow it`);
    }
    const parsed = tool.input.safeParse(params.arguments ?? {});
    if (!parsed.success) return toolError(`Invalid arguments: ${parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`);
    try {
      const value = await tool.run(this.api(definition, connection.accessToken), parsed.data);
      return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
    } catch (error) {
      if (error instanceof GoogleApiError) return toolError(`Google API error ${error.status}: ${error.message}`);
      throw error;
    }
  }

  /** A REST client confined to the definition's own Google API (B39). */
  api(definition: FirstPartyDefinition, accessToken: string): GoogleApi {
    const { endpoints } = this;
    const bases = { 'google.gmail': [endpoints.gmail], 'google.calendar': [endpoints.calendar], 'google.drive': [endpoints.drive, endpoints.driveUpload] }[this.service(definition).catalogId];
    return new GoogleApi(accessToken, endpoints, this.privateNetwork, bases);
  }

  /** The connect parameters the shared OAuth begin seals into the pending row. */
  authorization(definition: FirstPartyDefinition): McpFirstPartyAuthorization {
    const service = this.service(definition);
    const client = this.client();
    return {
      metadata: {
        issuer: this.endpoints.issuer,
        authorization_endpoint: this.endpoints.authorization,
        token_endpoint: this.endpoints.token,
        // No revocation_endpoint, so none is stored in a connection: revoking
        // one Google token ends the account's WHOLE grant to tm8 — every
        // Gmail, Calendar and Drive connection of it — so no single disconnect
        // may reach it (B39). Revoke-all uses this host's own endpoint.
        code_challenge_methods_supported: ['S256'],
      },
      client: { id: client.clientId, method: 'client_secret_post', secret: client.clientSecret },
      scopes: [...service.scopes],
      authorizeParams: GOOGLE_AUTHORIZE_PARAMS,
      privateNetwork: this.privateNetwork,
    };
  }

  /**
   * The client for the code exchange, read from server configuration at the
   * CALLBACK: the secret is never sealed into the pending row.
   */
  oauthClient(): OAuthClient {
    const client = this.client();
    return { id: client.clientId, method: 'client_secret_post', secret: client.clientSecret };
  }

  /**
   * Google's refresh: the client secret comes from server configuration now
   * (it is never stored in a connection), and no RFC 8707 `resource` is sent.
   * Google normally returns no new refresh token, so the old one is kept.
   */
  async refresh(secret: McpOAuthSecret): Promise<McpOAuthSecret> {
    if (!secret.refreshToken) throw new Error('MCP OAuth account requires reconnect');
    if (secret.tokenEndpoint !== this.endpoints.token || secret.issuer !== this.endpoints.issuer) throw new Error('MCP account binding mismatch');
    const client = this.client();
    if (secret.clientId !== client.clientId) throw new Error('MCP OAuth account requires reconnect');
    const response = await mcpHttp({
      url: this.endpoints.token, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: secret.refreshToken, client_id: client.clientId, client_secret: client.clientSecret }).toString(),
    }, this.privateNetwork);
    if (response.status !== 200) throw new OAuthTokenError(oauthErrorCode(response.body));
    let value: Record<string, unknown>;
    try { value = JSON.parse(response.body) as Record<string, unknown>; }
    catch { throw new Error('OAuth token exchange failed'); }
    if (typeof value.access_token !== 'string' || !value.access_token || typeof value.token_type !== 'string' || value.token_type.toLowerCase() !== 'bearer') {
      throw new Error('OAuth token response invalid');
    }
    return {
      ...secret,
      accessToken: value.access_token,
      ...(typeof value.refresh_token === 'string' && value.refresh_token ? { refreshToken: value.refresh_token } : {}),
      ...(typeof value.expires_in === 'number' ? { expiresAt: Date.now() + value.expires_in * 1000 } : {}),
      // A refresh reports the grant as it is NOW: a scope the person removed at
      // Google drops its tools at once.
      ...(typeof value.scope === 'string' ? { grantedScopes: value.scope.split(' ').filter(Boolean) } : {}),
    };
  }

  /**
   * Revoke tm8's grant at Google (§9.3(4)). This ends the WHOLE grant of the
   * Google account on tm8's client — every Gmail, Calendar and Drive connection
   * of that account, in every Space — so only the revoke-all kill switch calls
   * it, never a single disconnect (B39). Best-effort: false on any failure.
   */
  async revoke(secret: McpOAuthSecret): Promise<boolean> {
    const token = secret.refreshToken ?? secret.accessToken;
    if (!token || secret.issuer !== this.endpoints.issuer) return false;
    try {
      const response = await mcpHttp({
        url: this.endpoints.revocation, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
      }, this.privateNetwork);
      return response.status === 200;
    } catch { return false; }
  }

  /**
   * The connection's account label (§5.2): the Google account's address, from
   * userinfo. Best-effort: a connect is never lost to a userinfo hiccup, it is
   * stored without a label instead.
   */
  async accountLabel(accessToken: string): Promise<string | undefined> {
    try {
      const response = await mcpHttp({ url: this.endpoints.userinfo, method: 'GET', headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } }, this.privateNetwork);
      if (response.status !== 200) return undefined;
      const value = JSON.parse(response.body) as { email?: unknown };
      return typeof value.email === 'string' && value.email && value.email.length <= 200 && !/[\r\n\0]/.test(value.email) ? value.email : undefined;
    } catch { return undefined; }
  }

  private client() {
    const client = this.options.client();
    if (!client?.clientId || !client.clientSecret) throw new Error(GOOGLE_NOT_CONFIGURED);
    return client;
  }
}

/**
 * The part of a reported grant that belongs to this connector. With
 * include_granted_scopes Google reports the account's whole grant, so a Drive
 * token lists the Gmail scopes too; that is the grant, not this connection's
 * access, and neither the stored row nor the tool list may claim it.
 */
export function googleScopesFor(service: GoogleFirstPartyService, granted: readonly string[] | undefined): string[] {
  return service.scopes.filter(scope => granted?.includes(scope));
}

function toolError(text: string) {
  return { isError: true, content: [{ type: 'text', text }] };
}
