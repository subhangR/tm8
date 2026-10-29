/**
 * §10.0 — THE SHARED ROW MODEL. One row is `{connector, access, status,
 * toggle, action}`, and this file is the only place that decides which —
 * including which ACCOUNT a pick opens (`resolvedAccount`, §3's order) and how
 * a switch or an account choice edits the selection (`toggled`, `pinned`).
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
  /** The status in a chip's width ("Reconnect", "Not connected"). */
  short: string;
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
  /**
   * The connection a pick of this row opens: the pin when it is usable, else
   * `resolvedAccount`'s. Undefined for a connector that needs no account, and
   * when nothing would open — a pin to a dead account, or only a connection
   * shared WITH the viewer, which the server never chooses by itself.
   */
  account: McpAccount | undefined;
  /** The pick names an account that no longer opens (revoked, expired, removed). */
  deadPin: boolean;
  action: ConnectorAction;
  /** The viewer can use or fix it themselves; false while it waits on an admin (`ADMINS_TO_FIX`). */
  actionable: boolean;
}

/** Connected accounts the viewer may use. */
export function usableAccounts(server: McpServer): McpAccount[] {
  return server.accounts.filter(a => a.canUse && a.status === 'connected');
}

/**
 * The connection `bind` opens for a pick that names none, in the order
 * `resolve_mcp_account` (341) takes them — §3 below the pin: the viewer's OWN
 * connection first, then the Space's shared one (Space-owned before a member's
 * public one), oldest first within each, which is the order the accounts
 * arrive in.
 *
 * A connection merely shared WITH the viewer is deliberately not on the list:
 * the resolver uses one only when it is pinned. "Own" is read without knowing
 * who the viewer is: a usable account with no share at all can only be theirs,
 * and a shared one is theirs when they manage it (`manageable` is "owner is
 * me" for a member's row).
 */
export function resolvedAccount(server: McpServer, usable: readonly McpAccount[] = usableAccounts(server)): McpAccount | undefined {
  return usable.find(a => a.sharing === 'private' || (a.ownerId !== undefined && a.canManage))
    ?? usable.find(a => a.sharing === 'space' && a.ownerId === undefined)
    ?? usable.find(a => a.sharing === 'space');
}

/** The account a pick opens: the usable pin, or §3's choice when there is no pin. */
export function pickedAccount(server: McpServer, credentialId: string | undefined, usable: readonly McpAccount[] = usableAccounts(server)): McpAccount | undefined {
  if (server.auth === 'none') return undefined;
  if (credentialId) return usable.find(a => a.id === credentialId);
  return resolvedAccount(server, usable);
}

/**
 * One row switched on or off, starting from the EFFECTIVE set. Every surface
 * that draws switches produces its explicit list here, so turning the last one
 * off is `[]` everywhere and never `undefined` (the three-value rule in
 * `ConnectorToggleList`).
 */
export function toggled(selected: readonly McpSelection[], serverId: string, on: boolean): McpSelection[] {
  return on
    ? [...selected.filter(s => s.serverId !== serverId), { serverId }]
    : selected.filter(s => s.serverId !== serverId);
}

/** One pick's account pinned (or, with '', unpinned back to §3's choice). */
export function pinned(selected: readonly McpSelection[], serverId: string, credentialId: string): McpSelection[] {
  return selected.map(s => s.serverId === serverId
    ? { serverId, ...(credentialId ? { credentialId } : {}) }
    : s);
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

/** `short` is the same status in a chip's width; `text` stays the sentence (and the chip's tooltip). */
const COPY: Record<ConnectorStatus, { glyph: string; text: string; short: string }> = {
  ready: { glyph: '●', text: 'Ready', short: 'Ready' },
  credential_required: { glyph: '○', text: 'Not connected', short: 'Not connected' },
  credential_expired: { glyph: '⚠', text: 'Needs reconnect — the connection expired', short: 'Reconnect' },
  credential_revoked: { glyph: '⚠', text: 'Needs reconnect — the connection was revoked', short: 'Reconnect' },
  needs_reconnect: { glyph: '⚠', text: 'Needs reconnect', short: 'Reconnect' },
  credential_definition_changed: { glyph: '⚠', text: 'Connector settings changed by an admin', short: 'Reconnect' },
  not_approved: { glyph: '⏳', text: 'Awaiting approval', short: 'Awaiting approval' },
  disabled: { glyph: '⦸', text: 'Disabled by an admin', short: 'Disabled' },
  stdio_not_trusted: { glyph: '⛔', text: 'Local command not trusted on this node', short: 'Not trusted' },
  server_unavailable: { glyph: '⚠', text: 'Can’t reach this connector', short: 'Unreachable' },
  access_denied: { glyph: '⛔', text: 'You can’t use this connection', short: 'No access' },
};

/**
 * Statuses whose remedy is an ADMIN's — approve it, enable it, trust its
 * command, grant access — rather than the viewer's own switch or account.
 */
const ADMINS_TO_FIX: ReadonlySet<ConnectorStatus> = new Set<ConnectorStatus>(['not_approved', 'disabled', 'stdio_not_trusted', 'access_denied']);

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

/** The remedy §10.0 offers for this connector's status: connect, reconnect, approve… */
export function connectorAction(server: McpServer): ConnectorAction {
  return ACTION[connectorStatus(server)];
}

/**
 * What `bind` refuses about the connector's DEFINITION, whoever asks: not
 * approved, disabled, or a local command the node does not trust (an absent
 * flag is untrusted: the server refuses on `!stdioTrusted`). Shared by the row
 * status and the launch gate, which must refuse exactly what the row shows.
 */
export function definitionRefusal(server: McpServer): 'not_approved' | 'disabled' | 'stdio_not_trusted' | null {
  if (!server.approved) return 'not_approved';
  if (!server.enabled) return 'disabled';
  if (server.transport === 'stdio' && !server.source?.stdioTrusted) return 'stdio_not_trusted';
  return null;
}

/** The §10.0 status of one connector, for this viewer. */
export function connectorStatus(server: McpServer): ConnectorStatus {
  // The definition first: the server clears `canAttach` for an unapproved or
  // disabled connector, and the admin's state is the truer label.
  const refused = definitionRefusal(server);
  if (refused) return refused;
  if (!server.canAttach) return 'access_denied';
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
 * "Just me" / "Shared" / "Shared with you" — WHOSE connection a pick opens,
 * read off the account it would actually use (the usable pin, else §3's
 * choice; nothing for a dead pin). A Space-owned connection has `ownerId: null`
 * by construction (G2), and a member's row is the viewer's own exactly when
 * they manage it (`manageable` is "owner is me"); anyone else's is shared
 * WITH the viewer.
 */
function accessOf(server: McpServer, account: McpAccount | undefined): string {
  if (server.auth === 'none' || !account) return '—';
  if (account.ownerId === undefined) return 'Shared';
  return account.canManage ? 'Just me' : 'Shared with you';
}

/**
 * Every row the viewer may see, in catalog order: what they may attach, plus
 * what an admin's state keeps from them (awaiting approval, disabled) — the
 * server clears `canAttach` for those, but they are drawn inert with that
 * state, never switchable on, so the launch shows what the Space holds.
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
  return catalog.servers.filter(server => server.canAttach || definitionRefusal(server) !== null).map(server => {
    const pick = selected.find(s => s.serverId === server.id);
    const status = connectorStatus(server);
    const copy = COPY[status];
    // Resolved ONCE per row; access, account and the dead pin all read it.
    const usable = usableAccounts(server);
    const account = pickedAccount(server, pick?.credentialId, usable);
    return {
      server,
      status,
      glyph: copy.glyph,
      // A catalog that named its own reason says it, rather than being
      // paraphrased into the generic line.
      text: status === 'access_denied' && server.unavailableReason ? server.unavailableReason : copy.text,
      short: copy.short,
      access: accessOf(server, account),
      toggle: status === 'ready' || status === 'server_unavailable' || Boolean(pick),
      on: Boolean(pick),
      fromDefault: Boolean(pick) && !explicit,
      credentialId: pick?.credentialId,
      accounts: usable,
      account,
      deadPin: Boolean(pick?.credentialId) && !account,
      action: ACTION[status],
      actionable: !ADMINS_TO_FIX.has(status),
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
