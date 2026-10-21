import type { McpOAuthSecret } from '../credential-store.js';

/**
 * A first-party connector host (§8.1): an MCP resource server that runs INSIDE
 * the tm8 server process, for a provider that hosts no MCP server of its own.
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
