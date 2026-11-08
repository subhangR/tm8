/**
 * THE §10.0 SHARED ROW MODEL — one status vocabulary for every connector
 * surface (the Connectors table, the chat + sheet, the launch section, the
 * read-only debug view).
 *
 * WHY IT IS A PURE MODULE. Before it, each surface re-derived "is this usable"
 * from its own reading of `McpServer`: `McpPicker` asked `approved && enabled &&
 * some connected account`, `McpSettings` printed the raw reason string, and
 * `McpEquipment` printed a third wording. Three transcriptions of one rule
 * drifted exactly as far as that predicts — a connector an admin had disabled
 * read "Awaiting approval" in one place and "Disabled" in another. The table
 * below is the single statement of it, and it is data rather than JSX so the
 * mapping can be asserted without rendering anything.
 *
 * THE UI NEVER COMPUTES COVERAGE OR READINESS ITSELF (S10). Every status here
 * arrives from the server — `McpReadinessReason` on the connection, the
 * connector's own `approved`/`enabled` — and this module only ORDERS and
 * WORDS them. `provider_blocked` is the one exception and it is not a
 * computation either: only a failed `mcp.oauth.begin` can produce it, so the
 * caller passes it in.
 */
import type { McpCredentialStatusReason, McpReadinessReason, McpServerDefinition } from '@tm8/contract';
import type { McpAccount, McpServer } from './port';

/**
 * §10.0's vocabulary: every `McpReadinessReason` the server can report, plus
 * `provider_blocked`, which has no server reason because it is the provider's
 * 403 to dynamic client registration — a thing only the Connect attempt learns.
 */
export type ConnectorStatus = McpReadinessReason | 'provider_blocked';

/** Which bucket the Status filter puts a row in (§10.1 "Connected / Needs attention / Not connected"). */
export type StatusGroup = 'connected' | 'attention' | 'unconnected';

export interface StatusRow {
  /** A text glyph, never an icon font or an image: the table must render with no asset load. */
  icon: string;
  /** The base wording. `statusLabel` adds the connector name or the reason where §10.0 asks for one. */
  label: string;
  /** May the chat/launch toggle be switched on? `server_unavailable` stays ON by design — the call may still work. */
  toggle: boolean;
  action: 'connect' | 'reconnect' | 'approve' | 'test' | 'settings' | null;
  /** The action is drawn only for a Space admin; everyone else gets the status and no button. */
  adminOnly?: boolean;
  tone: 'ok' | 'warn' | 'wait' | 'off';
  group: StatusGroup;
}

const RECONNECT: StatusRow = { icon: '⚠', label: 'Needs reconnect', toggle: false, action: 'reconnect', tone: 'warn', group: 'attention' };
const UNUSABLE: StatusRow = { icon: '⛔', label: "You can't use this connection", toggle: false, action: null, tone: 'off', group: 'attention' };

export const STATUS_ROWS: Record<ConnectorStatus, StatusRow> = {
  ready: { icon: '✓', label: 'Connected', toggle: true, action: null, tone: 'ok', group: 'connected' },
  credential_required: { icon: '·', label: 'Not connected', toggle: false, action: 'connect', tone: 'off', group: 'unconnected' },
  credential_expired: RECONNECT,
  credential_revoked: RECONNECT,
  needs_reconnect: RECONNECT,
  credential_definition_changed: { icon: '⚠', label: 'Connector settings changed', toggle: false, action: 'reconnect', tone: 'warn', group: 'attention' },
  not_approved: { icon: '⏳', label: 'Awaiting approval', toggle: false, action: 'approve', adminOnly: true, tone: 'wait', group: 'attention' },
  disabled: { icon: '⦸', label: 'Disabled', toggle: false, action: null, tone: 'off', group: 'attention' },
  stdio_not_trusted: { icon: '⛔', label: 'Local command not trusted on this node', toggle: false, action: 'settings', adminOnly: true, tone: 'off', group: 'attention' },
  // Enabled on purpose (§10.0): the health check failed, but a live call may
  // still succeed, and refusing the toggle would hide a working connector
  // behind one bad probe.
  server_unavailable: { icon: '⚠', label: "Can't reach this connector", toggle: true, action: 'test', tone: 'warn', group: 'attention' },
  access_denied: UNUSABLE,
  credential_unavailable: UNUSABLE,
  provider_blocked: { icon: '⛔', label: "This provider hasn't approved tm8 yet", toggle: false, action: 'settings', adminOnly: true, tone: 'off', group: 'attention' },
  /**
   * S5. The connector and the account are both fine and only the launch's
   * provenance is missing, so there is nothing for the person to connect —
   * offering [Connect] here would be a lie. THE CONNECTORS PAGE NEVER SHOWS
   * THIS (a page read always has a human behind it); it is here because the
   * chat and launch surfaces share this table.
   */
  no_human_provenance: { icon: '⛔', label: 'No person behind this launch', toggle: false, action: null, tone: 'off', group: 'attention' },
  /** B9: a stored definition that cannot be read as one. It only ever skips a default. */
  invalid_definition: { icon: '⛔', label: "This connector's settings can't be read", toggle: false, action: null, tone: 'off', group: 'attention' },
};

/** Why a connection stopped being honoured, in words (§5.2 `status_reason`). Never a secret. */
export const STATUS_REASON_COPY: Record<McpCredentialStatusReason, string> = {
  invalid_grant: 'the provider rejected the saved sign-in',
  security_revision_changed: 'an admin changed this connector',
  scope_reduced: 'access was reduced in Google',
  possible_reuse: 'a possible token reuse was detected',
};

/**
 * §10.0's wording, with the two substitutions the table asks for: the
 * connector's name where the copy says `<name>`, and the connection's
 * `statusReason` appended to "Needs reconnect".
 */
export function statusLabel(status: ConnectorStatus, context: { name: string; statusReason?: McpCredentialStatusReason | null }): string {
  if (status === 'server_unavailable') return `Can't reach ${context.name}`;
  if (status === 'provider_blocked') return `${context.name} hasn't approved tm8 yet`;
  const row = STATUS_ROWS[status];
  if (row === RECONNECT && context.statusReason) return `${row.label} · ${STATUS_REASON_COPY[context.statusReason]}`;
  return row.label;
}

/** The connection this row is about, and why it reads the way it does. */
export interface ConnectorRowStatus {
  status: ConnectorStatus;
  /** The connection the status came from, when a connection is what is wrong. */
  account?: McpAccount;
  statusReason?: McpCredentialStatusReason | null;
}

/**
 * How bad each connection reason is. The row reports the WORST thing about the
 * connections this viewer has, so a member with one expired account and one
 * they were never granted sees "Needs reconnect" (which they can act on)
 * rather than "You can't use this connection" (which they cannot).
 */
const REASON_RANK: Partial<Record<McpReadinessReason, number>> = {
  needs_reconnect: 5, credential_expired: 4, credential_revoked: 3,
  credential_definition_changed: 2, credential_unavailable: 1, access_denied: 0,
};

/**
 * §10.0 for one table row. Order is FAIL-CLOSED, worst first: a connector an
 * admin has not approved reads "Awaiting approval" whatever its connections
 * look like, because approval is what has to happen next.
 */
export function rowStatusOf(server: McpServer): ConnectorRowStatus {
  if (!server.approved) return { status: 'not_approved' };
  if (!server.enabled) return { status: 'disabled' };
  if (server.transport === 'stdio' && server.source?.stdioTrusted !== true) return { status: 'stdio_not_trusted' };
  const unreachable = server.health && !server.health.ready && server.health.reason === 'server_unavailable';
  if (server.auth === 'none') return unreachable ? { status: 'server_unavailable' } : { status: 'ready' };
  const ready = server.accounts.find(account => account.canUse && account.status === 'connected');
  if (ready) {
    return unreachable
      ? { status: 'server_unavailable', account: ready }
      : { status: 'ready', account: ready, statusReason: ready.statusReason ?? null };
  }
  // No usable connection. Report the most actionable of the ones that exist,
  // and `credential_required` when there are none at all — which is the only
  // state [Connect] belongs on.
  let worst: ConnectorRowStatus | null = null;
  for (const account of server.accounts) {
    const reason = account.status === 'revoked' ? 'credential_revoked' : (account.status as McpReadinessReason);
    const rank = REASON_RANK[reason];
    if (rank === undefined) continue;
    const best = worst?.status ? REASON_RANK[worst.status as McpReadinessReason] ?? -1 : -1;
    if (rank > best) worst = { status: reason, account, statusReason: account.statusReason ?? null };
  }
  return worst ?? { status: 'credential_required' };
}

/**
 * §10.1's Access column. "Just me" is a connection this viewer owns —
 * `manageable` on a member-scoped row means exactly "the owner is me" (341's
 * `list_mcp_credentials`), so no viewer identity has to be passed in.
 *
 * Both tiers at once reads "Just me + Shared" because §3 resolves PERSONAL
 * FIRST: the shared row exists but this viewer's sessions will not use it.
 */
export function accessLabel(server: McpServer): string {
  const live = server.accounts.filter(account => account.status !== 'revoked');
  const mine = live.some(account => account.scope !== 'space' && account.canManage);
  const shared = live.some(account => account.scope === 'space');
  const lent = live.find(account => account.scope !== 'space' && !account.canManage && account.canUse);
  if (mine && shared) return 'Just me + Shared';
  if (mine) return 'Just me';
  if (shared) return 'Shared';
  if (lent) return `Shared by ${lent.ownerLabel ?? 'another member'}`;
  return '—';
}

/**
 * S10's amber "Limited access" badge: the number of tools the connection this
 * row is using cannot reach, as the SERVER counted them
 * (`unavailableToolCount`, §11). Zero, null and absent all mean no badge — and
 * they mean different things, which is why this reads the field rather than
 * comparing scope lists. S10 forbids the UI working coverage out itself.
 */
export function limitedAccessCount(status: ConnectorRowStatus): number {
  if (status.status !== 'ready') return 0;
  const count = status.account?.unavailableToolCount;
  return typeof count === 'number' && count > 0 ? count : 0;
}

/**
 * S8's test, and the only one allowed: `firstParty` plus a `google.` catalog id.
 * NOT the URL — a first-party connector's URL is tm8's own origin, and a custom
 * connector pointed at googleapis.com is still not a tm8-hosted Google
 * connection with a Google grant behind it.
 */
export function isGoogleConnector(definition: Pick<McpServerDefinition, 'firstParty' | 'catalogId'> | undefined): boolean {
  return definition?.firstParty === true && (definition.catalogId ?? '').startsWith('google.');
}

/** §10.1's Type column, derived from the definition (S2: no `typeLabel` on the wire). */
export function typeLabel(server: Pick<McpServer, 'transport' | 'source'>): string {
  if (server.transport === 'stdio') return 'Local';
  if (isGoogleConnector(server.source)) return 'Google · tm8';
  if (server.source?.firstParty) return 'tm8';
  return server.source?.catalogId ? 'Remote' : 'Remote Custom';
}

/** §10.1: "search matches name, catalog id and account label". */
export function matchesSearch(server: McpServer, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [server.title, server.source?.catalogId ?? '', ...server.accounts.flatMap(a => [a.label, a.accountLabel ?? ''])];
  return haystack.some(value => value.toLowerCase().includes(needle));
}

export interface ConnectorFilter {
  status: StatusGroup | 'all';
  access: 'all' | 'personal' | 'shared';
  type: 'all' | 'first_party' | 'remote' | 'local';
}
export const NO_FILTER: ConnectorFilter = { status: 'all', access: 'all', type: 'all' };
export const FILTERING = (filter: ConnectorFilter): boolean =>
  filter.status !== 'all' || filter.access !== 'all' || filter.type !== 'all';

export function matchesFilter(server: McpServer, status: ConnectorStatus, filter: ConnectorFilter): boolean {
  if (filter.status !== 'all' && STATUS_ROWS[status].group !== filter.status) return false;
  if (filter.access !== 'all') {
    const label = accessLabel(server);
    const personal = label === 'Just me' || label === 'Just me + Shared';
    const shared = label === 'Shared' || label === 'Just me + Shared' || label.startsWith('Shared by');
    if (filter.access === 'personal' ? !personal : !shared) return false;
  }
  if (filter.type !== 'all') {
    const kind = server.transport === 'stdio' ? 'local' : server.source?.firstParty ? 'first_party' : 'remote';
    if (kind !== filter.type) return false;
  }
  return true;
}
