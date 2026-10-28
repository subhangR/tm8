/**
 * §10.0 — THE SHARED ROW MODEL. One row is `{connector, access, status,
 * toggle, action}`, and this file is the only place that decides which.
 *
 * It is separated from `ConnectorToggleList` because three surfaces draw the
 * same rows in three shapes — the chat sheet, the launch section's grid, and
 * the debug view's read-only list — and the rule "which status, which copy,
 * can the toggle move" must not be re-derived per surface. That is how the
 * composer ends up calling a connector connected that the launch dialog beside
 * it calls expired.
 *
 * THE STATUS VOCABULARY IS THE CONTRACT'S, not a second one invented here:
 * every value below is a member of `McpReadinessReason` (`contract/mcp.ts`),
 * which is what `bind` and `mcp.resolve` answer with. Two notes on the
 * difference between this file and the server's resolver:
 *
 *  - This is a LABEL, never an authorization. The server resolves what a launch
 *    actually gets, under the provenance root's own claims (§3, §6); the
 *    browser only ever sees what the viewer can read. A row that says `ready`
 *    is therefore a hint, and §5.3's rule — omit the field unless the human
 *    changed something — is what keeps that hint out of the decision.
 *  - `provider_blocked` (§10.0's last row, the DCR 403 state) is DELIBERATELY
 *    ABSENT. Nothing in the catalog reports it today: it is not a member of
 *    `McpReadinessReason`, and no field on `McpServerView` carries it. Adding a
 *    branch for it here would be a row state that cannot occur, which is worse
 *    than its absence — it would read as covered.
 */
import type { McpAccount, McpCatalog, McpSelection, McpServer } from './port';

/** Exactly the §10.0 table's rows, minus the one nothing can report. */
export type ConnectorStatus =
  | 'ready'
  | 'credential_required'
  | 'credential_expired'
  | 'credential_revoked'
  | 'needs_reconnect'
  | 'credential_definition_changed'
  | 'not_approved'
  | 'disabled'
  | 'stdio_not_trusted'
  | 'server_unavailable'
  | 'access_denied';

/** What the row offers the viewer, beyond the toggle. */
export type ConnectorAction = 'none' | 'connect' | 'reconnect' | 'approve' | 'test' | 'settings';

export interface ConnectorRow {
  server: McpServer;
  status: ConnectorStatus;
  /** §10.0's glyph. Decorative — the text beside it carries the meaning. */
  glyph: string;
  /** §10.0's copy for this status, with the reason the catalog gave when it gave one. */
  text: string;
  /** "Just me", "Shared", or "—" for a connector that needs no account. */
  access: string;
  /**
   * Can the switch be moved? §10.0: only `ready` and `server_unavailable` are
   * switchable — the second deliberately, because the server may well be back
   * by the time the session runs and refusing the toggle would be a guess.
   * A row already IN the selection can always be switched OFF, whatever its
   * status: a selection you cannot withdraw is a trap, and withdrawing one is
   * the remedy `bind`'s own refusal tells you to apply.
   */
  toggle: boolean;
  /** This connector is on, in the effective set (explicit or default). */
  on: boolean;
  /** True when `on` comes from the Space's defaults rather than a human's pick. */
  fromDefault: boolean;
  /** The pinned account, when the human pinned one. */
  credentialId: string | undefined;
  /** Connected accounts the viewer may use — the account picker's options. */
  accounts: McpAccount[];
  action: ConnectorAction;
}

function usableAccounts(server: McpServer): McpAccount[] {
  return server.accounts.filter(a => a.canUse && a.status === 'connected');
}

/**
 * The WORST thing wrong with the connections this viewer can see, so the row
 * reports the state a person can act on rather than the first one in the list.
 *
 * Order matters and is the order of §10.0's table: a revoked connection and an
 * expired one are different remedies, and "not connected" is the state with no
 * remedy but [Connect]. `status` here is the UI account status the adapter
 * built — `'connected'`, `'revoked'`, or the readiness reason verbatim — so
 * this reads the contract's vocabulary, not a parallel one.
 */
function credentialStatus(server: McpServer): ConnectorStatus {
  // EVERY account the viewer can SEE, not only the ones they may use.
  //
  // An unusable account is the thing that explains the row: a revoked one
  // needs reconnecting, an expired one needs reconnecting, and a connection
  // belonging to somebody else leaves the viewer at "not connected" — whose
  // remedy is [Connect], a private account of their own. Filtering to
  // `canUse` first would throw away exactly the rows that carry the reason
  // and leave every one of these cases as a bare "Not connected".
  const statuses = new Set(server.accounts.map(a => a.status));
  if (statuses.has('needs_reconnect')) return 'needs_reconnect';
  if (statuses.has('credential_expired')) return 'credential_expired';
  if (statuses.has('revoked') || statuses.has('credential_revoked')) return 'credential_revoked';
  if (statuses.has('credential_definition_changed')) return 'credential_definition_changed';
  return 'credential_required';
}

const COPY: Record<ConnectorStatus, { glyph: string; text: string }> = {
  ready: { glyph: '●', text: 'Ready' },
  credential_required: { glyph: '○', text: 'Not connected' },
  credential_expired: { glyph: '⚠', text: 'Needs reconnect — the connection expired' },
  credential_revoked: { glyph: '⚠', text: 'Needs reconnect — the connection was revoked' },
  needs_reconnect: { glyph: '⚠', text: 'Needs reconnect' },
  credential_definition_changed: { glyph: '⚠', text: 'Connector settings changed by an admin' },
  not_approved: { glyph: '⏳', text: 'Awaiting approval' },
  disabled: { glyph: '⦸', text: 'Disabled by an admin' },
  stdio_not_trusted: { glyph: '⛔', text: 'Local command not trusted on this node' },
  server_unavailable: { glyph: '⚠', text: 'Can’t reach this connector' },
  access_denied: { glyph: '⛔', text: 'You can’t use this connection' },
};

const ACTION: Record<ConnectorStatus, ConnectorAction> = {
  ready: 'none',
  credential_required: 'connect',
  credential_expired: 'reconnect',
  credential_revoked: 'reconnect',
  needs_reconnect: 'reconnect',
  credential_definition_changed: 'reconnect',
  not_approved: 'approve',
  disabled: 'none',
  stdio_not_trusted: 'settings',
  server_unavailable: 'test',
  access_denied: 'none',
};

/** The §10.0 status of one connector, for this viewer. */
export function connectorStatus(server: McpServer): ConnectorStatus {
  if (!server.canAttach) return 'access_denied';
  if (!server.approved) return 'not_approved';
  if (!server.enabled) return 'disabled';
  if (server.transport === 'stdio' && server.source?.stdioTrusted === false) return 'stdio_not_trusted';
  if (server.auth !== 'none' && usableAccounts(server).length === 0) return credentialStatus(server);
  // The health record is the viewer's own last test of this connector
  // (`mcp_server_health` is keyed by member), so an unreachable server is
  // reported even while its connection is perfectly good.
  if (server.health && !server.health.ready && server.health.reason === 'server_unavailable') {
    return 'server_unavailable';
  }
  return 'ready';
}

/**
 * "Just me" / "Shared" — WHOSE connection would carry this connector.
 *
 * Read off the account that would actually be used, not off the connector:
 * one connector can hold a personal connection and a Space-owned one at once
 * (§5.2), and which of them answers is §3's order, not a property of the row.
 * A Space-owned connection has `ownerId: null` by construction (G2).
 */
export function connectorAccess(server: McpServer, credentialId?: string): string {
  if (server.auth === 'none') return '—';
  const accounts = usableAccounts(server);
  const pinned = credentialId ? accounts.find(a => a.id === credentialId) : undefined;
  const account = pinned ?? accounts[0];
  if (!account) return '—';
  return account.ownerId ? 'Just me' : 'Shared';
}

/**
 * Every row the viewer may see, in catalog order.
 *
 * `selected` is the EFFECTIVE set — `value ?? catalog.defaults` — and
 * `explicit` says which of the two it was, because §10.4's header and §10.5's
 * summary both turn on exactly that distinction and a row cannot recover it
 * from the list alone (S21: a default set and a human's identical pick are the
 * same list).
 */
export function connectorRows(
  catalog: McpCatalog,
  selected: readonly McpSelection[],
  explicit: boolean,
): ConnectorRow[] {
  return catalog.servers.filter(server => server.canAttach).map(server => {
    const pick = selected.find(s => s.serverId === server.id);
    const status = connectorStatus(server);
    const copy = COPY[status];
    return {
      server,
      status,
      glyph: copy.glyph,
      // A catalog that named its own reason says it, rather than being
      // paraphrased into the generic line.
      text: status === 'access_denied' && server.unavailableReason ? server.unavailableReason : copy.text,
      access: connectorAccess(server, pick?.credentialId),
      toggle: status === 'ready' || status === 'server_unavailable' || Boolean(pick),
      on: Boolean(pick),
      fromDefault: Boolean(pick) && !explicit,
      credentialId: pick?.credentialId,
      accounts: usableAccounts(server),
      action: ACTION[status],
    };
  });
}

/** The chip's count (§10.4): switched on AND ready. */
export function readyCount(rows: readonly ConnectorRow[]): number {
  return rows.filter(row => row.on && row.status === 'ready').length;
}

/** §10.4: an amber dot on the chip — something switched on needs a reconnect. */
export function needsAttention(rows: readonly ConnectorRow[]): boolean {
  return rows.some(row => row.on && row.action === 'reconnect');
}
