import type { McpAuditListResult, McpCatalogEntry, McpCredentialScope, McpCredentialStatusReason, McpServerDefinition, McpSessionProvenance, McpTestResult, McpUnavailableTool } from '@tm8/contract';
/** UI-only values. Account metadata never contains provider credentials. */
export interface McpSelection { serverId: string; credentialId?: string }
export interface McpAccount {
  id: string; label: string; ownerId?: string; ownerLabel?: string; canUse: boolean; canManage: boolean;
  status: string; sharing: 'private' | 'members' | 'space'; memberIds?: string[];
  /** Who owns the connection: `member` is "Just me", `space` is "Shared" (§5.2, G2). */
  scope?: McpCredentialScope;
  /** Why it stopped being honoured, for the §10.0 "Needs reconnect plus the reason" copy. */
  statusReason?: McpCredentialStatusReason | null;
  /** The PROVIDER's own name for the account ("subhang@gmail.com"), filled at the OAuth callback. */
  accountLabel?: string | null;
  /** What the provider actually granted. The UI RENDERS these; it never computes coverage from them (S10). */
  grantedScopes?: string[];
  lastUsedAt?: string | null; lastRefreshAt?: string | null;
  authType?: 'api_key' | 'oauth2';
  /**
   * How many tools this connection cannot use for want of a granted scope
   * (S10's "Limited access" badge). NULL or absent means nobody can say — a
   * relayed connector's tool→scope map lives at the provider — and the badge
   * is then not drawn. The UI never computes this.
   */
  unavailableToolCount?: number | null;
}
export interface McpServer {
  id: string; version: number; title: string; description: string;
  transport: 'http' | 'stdio'; url?: string; command?: string; args?: string[];
  auth: 'none' | 'api_key' | 'oauth'; approved: boolean; enabled: boolean;
  source?: McpServerDefinition; health?: McpTestResult; canApprove?: boolean;
  canManage: boolean; canAttach: boolean; unavailableReason?: string;
  accounts: McpAccount[];
}
export interface McpCatalog {
  attachedServerIds?: string[];
  servers: McpServer[]; defaults: McpSelection[]; canRegister: boolean; canAttach: boolean;
}
/**
 * `mcp.servers.test`, as the drawer reads it.
 *
 * `unavailableTools` is the contract's own `McpUnavailableTool` (#1323): the
 * tools a PARTIAL Google grant does not cover, computed by the first-party
 * host from the connection's granted scopes. It is absent for every connector
 * that is not first-party, and the banner stays silent then — S10 forbids this
 * module working coverage out for itself.
 */
export interface McpTestReport {
  ok: boolean; message: string; tools: { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
  unavailableTools?: McpUnavailableTool[];
}
export interface McpDefinition {
  title: string; description: string; transport: 'http' | 'stdio';
  url?: string; command?: string; args?: string[]; auth: 'none' | 'api_key' | 'oauth';
  trustedCode?: boolean; approved?: boolean; allowPrivateNetwork?: boolean;
  secretSlot?: string; prefix?: 'Bearer' | 'none';
  issuer?: string; authorizationUrl?: string; tokenUrl?: string; clientId?: string; clientSecretEnv?: string; scopes?: string[];
}
/** Where a Discover "Add" landed. `adopted` is B22/B25: an OPEN member request was approved instead of a second connector being created. */
export interface McpAddOutcome { serverId: string; adopted: boolean }
export interface McpPort {
  catalog(targetId?: string, teamMemberId?: string): Promise<McpCatalog>;
  /** §8.2 via `mcp.catalog.list` with this Space, so each entry reports where it is already added (B16). */
  catalogEntries(): Promise<McpCatalogEntry[]>;
  /**
   * Admin "Add to Space" on a Discover card. B22/B25: a catalog entry with an
   * OPEN member request is ADOPTED (`mcp.servers.update` approved=true) rather
   * than created twice, including when the create races and comes back
   * `conflict` naming the existing id.
   */
  addFromCatalog(catalogId: string): Promise<McpAddOutcome>;
  /** Member "Request" on a Discover card, or a custom connector a member asks for. */
  request(input: { catalogId: string } | { definition: McpDefinition }, note?: string): Promise<void>;
  /**
   * An exact patch of the stored definition. It replaces `update`'s lossy
   * round-trip for the admin toggles: `definitionFor` rebuilds a definition out
   * of the FORM's fields, so sending approval through it would drop every field
   * the form has no input for.
   */
  patch(server: McpServer, patch: Partial<McpServerDefinition>): Promise<void>;
  register(input: McpDefinition): Promise<void>;
  update(server: McpServer, input: McpDefinition & { enabled: boolean }): Promise<void>;
  remove(server: McpServer): Promise<void>;
  /** Resolves with the member-facing summary of what was imported and what still needs a credential. */
  importConfig(json: string, trustedCode: boolean): Promise<string>;
  /** The rows a person ticked in the §10.1 import preview, already parsed and stripped of secrets. */
  importMany(definitions: McpServerDefinition[]): Promise<void>;
  attach(targetId: string, serverId: string): Promise<void>;
  detach(targetId: string, serverId: string): Promise<void>;
  test(selection: McpSelection): Promise<McpTestReport>;
  /** `scope: 'space'` needs a Space admin and creates a Space-owned connection (§10.2 step 2). */
  createKey(serverId: string, label: string, secret: string, scope?: McpCredentialScope): Promise<void>;
  rotateKey(serverId: string, credentialId: string, secret: string): Promise<void>;
  /**
   * §10.2 step 4. `scope: 'space'` needs a Space admin. `returnTo` is a path on
   * tm8's own origin that the SERVER keeps on the pending row, so the same-tab
   * fallback (popup blocked) comes back to the screen the connect started on
   * even though the provider redirect lost every scrap of client state.
   */
  startOAuth(serverId: string, label: string, scope?: McpCredentialScope, returnTo?: string): Promise<{ authorizationUrl: string; expiresAt?: string }>;
  share(serverId: string, credentialId: string, sharing: 'private' | 'members' | 'space', memberIds: string[]): Promise<void>;
  revoke(serverId: string, credentialId: string): Promise<void>;
  members(): Promise<{ id: string; label: string }[]>;
  /**
   * §10.4 — a CHAT's stored selection, and the write that changes it.
   *
   * `null` is an ANSWER on both sides and means the same thing in both
   * directions: the thread has no stored row, so it runs on the Space's
   * defaults, resolved fresh at every turn (§5.3, S21b). Reading `null` is how
   * the sheet knows to say "Using: Space defaults"; writing `null` DELETES the
   * row, which is what "Reset to Space defaults" does — writing today's
   * defaults back instead would pin them and no later `defaultOn` would ever
   * reach the thread again.
   *
   * `setChatSelections` ANSWERS THE STORED VALUE rather than echoing the
   * request, so the sheet repaints from what landed instead of from what it
   * hoped. OPTIONAL, like the two below: a host that mounts the chat surface
   * against a build without these operations still satisfies the port, and the
   * sheet says so rather than drawing dead switches.
   */
  chatSelections?(chatId: string): Promise<McpSelection[] | null>;
  setChatSelections?(chatId: string, value: McpSelection[] | null): Promise<McpSelection[] | null>;
  /**
   * §10.6 — the provenance recorded for one session, as the server computed
   * it. `recorded:false` is a normal answer (nothing bound the session, or its
   * binding expired with its auth session), not an error, and the view says so.
   */
  sessionProvenance?(sessionId: string): Promise<McpSessionProvenance>;
  /**
   * §5.6 — the newest `mcp_call_audit` rows for one connector. `scope` is what
   * the caller was allowed to see: the whole Space, or only their own calls.
   * OPTIONAL like the two above; absent, the entity page omits Recent calls.
   */
  audit?(serverId: string, limit?: number): Promise<McpAuditListResult>;
}
