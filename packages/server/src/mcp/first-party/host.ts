import type { McpOAuthSecret } from '../credential-store.js';
import type { McpUnavailableTool } from '@tm8/contract';
import type { McpFirstPartyAuthorization, OAuthClient } from '../oauth.js';

/**
 * A first-party connector host (§8.1): an MCP resource server that runs INSIDE
 * the tm8 server process, exposing a provider API through native TM8 tools.
 *
 * The proxy calls it in place of `mcpHttp`, after the same access checks and
 * with the same decrypted connection, so no token ever leaves the server and no
 * subprocess is involved. The host answers `tools/list` and `tools/call` only;
 * there is no MCP session to initialize.
 */
export interface FirstPartyDefinition {
  url?: string;
  catalogId?: string;
  firstParty?: boolean;
  gates?: Record<string, boolean>;
}

/** The decrypted connection a call runs with: its token, and the scopes the provider reported for it. */
export interface FirstPartyConnection {
  accessToken: string;
  grantedScopes?: readonly string[];
}

export interface FirstPartyHost {
  request(definition: FirstPartyDefinition, method: 'tools/list' | 'tools/call', params: Record<string, unknown>, connection: FirstPartyConnection): Promise<unknown>;
  /** The provider's own refresh; the generic one sends an RFC 8707 `resource` the provider may refuse. */
  refresh(secret: McpOAuthSecret): Promise<McpOAuthSecret>;
  /** Whether a grant covers at least one tool; a refresh that leaves none marks the connection scope_reduced (B41). */
  covers?(definition: FirstPartyDefinition, grantedScopes: readonly string[] | undefined): boolean;
}

/** Static provider identity plus the shared OAuth/account lifecycle. */
export interface FirstPartyOAuthHost extends FirstPartyHost {
  authorization(definition: FirstPartyDefinition): McpFirstPartyAuthorization;
  oauthClient(): OAuthClient;
  accountLabel(accessToken: string): Promise<string | undefined>;
  scopesFor(definition: FirstPartyDefinition, scopes: readonly string[] | undefined): string[];
  tools(definition: FirstPartyDefinition, scopes: readonly string[] | undefined): readonly { name: string }[];
  uncovered(definition: FirstPartyDefinition, scopes: readonly string[] | undefined): McpUnavailableTool[];
}

/**
 * The provider refused the access token. The proxy refreshes once and retries,
 * exactly as it does for a relay's HTTP 401; never for anything else.
 */
export class FirstPartyUnauthorized extends Error {
  constructor() { super('MCP upstream unauthorized'); }
}

/** A connector the in-process host does not serve, or a definition that does not match it. */
export class FirstPartyRefused extends Error {}
