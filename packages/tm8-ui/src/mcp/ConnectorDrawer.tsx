/**
 * THE ROW DRAWER (§10.1 "Row click → detail drawer").
 *
 * One connector, in the order a person asks about it: what is wrong with it,
 * the connection they own, the connection the Space owns, what tools it has,
 * what it does by default, and only then the ways to break it.
 *
 * THREE RULES THIS FILE KEEPS, each from a ruling rather than from taste:
 *
 *  - S8/B39. [Disconnect] on a first-party GOOGLE connection says what it
 *    actually does. One Google grant spans every Google connector and every
 *    Space, so disconnecting here stops tm8 using the connection and does NOT
 *    revoke tm8's access at Google. The copy says that and links to Google's
 *    own permissions page. Other providers keep today's wording, which is true
 *    for them.
 *  - S9. The Gmail send gate is part of the definition fingerprint (B1), so
 *    flipping it really does invalidate every connection. The confirm says how
 *    many, in BOTH directions, before the write.
 *  - §10.2. Connect and Reconnect run the POPUP flow (`useConnect`), not the
 *    same-tab link this file used to render. Every fallback row of that table
 *    shows up here: the browser blocking the window, the person closing it, the
 *    provider refusing tm8 as a client, an expired state, an admin changing the
 *    connector mid-flow.
 *  - S10/S12. A partial Google grant is not a broken connection: it stays
 *    `ready`, and the gap shows here, from `unavailableTools` on
 *    `mcp.servers.test`. The UI never computes scope coverage — if the server
 *    does not report a gap, none is drawn.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { mcpServerKey, type McpCredentialScope } from '@tm8/contract';
import { Eyebrow } from '../kit';
import { ConnectorForm } from './ConnectorForm';
import { ConnectorLogo, serverLogo } from './connector-logos';
import { accessLabel, isGoogleConnector, rowStatusOf, statusLabel, typeLabel, STATUS_ROWS, type ConnectorRowStatus } from './connector-rows';
import { McpUiError, testFailure, type ConnectFailure } from './errors';
import { useConnect, type ConnectPhase } from './useConnect';
import { isPrivateHost } from './private-host';
import type { McpAccount, McpDefinition, McpPort, McpServer, McpTestReport } from './port';
import './connectors.css';

const GOOGLE_PERMISSIONS = 'https://myaccount.google.com/permissions';

/** S8: what a single [Disconnect] really does, per provider. */
function disconnectCopy(server: McpServer, account: McpAccount): { confirm: string; google: boolean } {
  if (isGoogleConnector(server.source)) {
    return { google: true, confirm: `Disconnect ${account.accountLabel ?? account.label}? tm8 stops using this connection. To remove tm8's access from your Google account entirely, use Google's permissions page.` };
  }
  return { google: false, confirm: `Disconnect ${account.label}? Sessions using this connection will lose access on their next tool call.` };
}

function when(value: string | null | undefined): string {
  if (!value) return 'never';
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? 'unknown' : at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** "4 min ago" for the last health check: how fresh the status is matters more than the wall-clock time. */
export function ago(value: string | null | undefined, now = Date.now()): string | null {
  if (!value) return null;
  const at = new Date(value).getTime();
  if (Number.isNaN(at)) return null;
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return when(value);
}

/**
 * One titled band of the detail view. The title is the kit's eyebrow — the
 * same mono caps every entity page draws its section labels in — and the
 * band's own actions sit on the title's line, so a section never spends a row
 * on one button.
 */
export function Section({ title, count, actions, className, children }: {
  title: string; count?: number; actions?: ReactNode; className?: string; children?: ReactNode;
}) {
  return <section className={`mcp-sec${className ? ` ${className}` : ''}`} aria-label={title}>
    <header className="mcp-sec__head">
      <h4><Eyebrow>{title}{count !== undefined ? ` · ${count}` : ''}</Eyebrow></h4>
      {actions && <div className="mcp-sec__actions">{actions}</div>}
    </header>
    {children}
  </section>;
}

/** §10.0's status as a pill: tone from `STATUS_ROWS`, wording from `statusLabel`. */
export function StatusPill({ server, row }: { server: McpServer; row: ConnectorRowStatus }) {
  const spec = STATUS_ROWS[row.status];
  return <span className={`mcp-state mcp-state--${spec.tone}`}>
    <span aria-hidden="true">{spec.icon}</span>
    {statusLabel(row.status, { name: server.title, statusReason: row.statusReason ?? null })}
  </span>;
}

/**
 * The controls for a connection THIS VIEWER manages: who may use it, and (for
 * an API key) replacing the secret. Each is ONE inline row — label, control,
 * its own Save — rather than a stacked form, because they are two independent
 * writes and each is a single field.
 *
 * §10.1's Access column knows two tiers, "Just me" and "Shared", but the data
 * model has a third the page must not silently drop — `visibility: 'selected'`,
 * a member-owned connection lent to named members (§5.2, B4's legacy tier).
 * Removing the control would leave those rows unmanageable from the UI that
 * created them, so it is kept here, in the one place the owner looks.
 */
function ConnectionControls({ account, server, port, busy, run }: {
  account: McpAccount; server: McpServer; port: McpPort; busy: boolean;
  run(action: () => Promise<unknown>, success: string): Promise<void>;
}) {
  const [sharing, setSharing] = useState(account.sharing);
  const [members, setMembers] = useState<{ id: string; label: string }[]>([]);
  const [memberIds, setMemberIds] = useState<string[]>(account.memberIds ?? []);
  const [memberError, setMemberError] = useState(false);
  useEffect(() => {
    let active = true;
    if (sharing === 'members') void port.members().then(
      rows => { if (active) { setMembers(rows); setMemberError(false); } },
      () => { if (active) setMemberError(true); },
    );
    return () => { active = false; };
  }, [port, sharing]);
  const changed = sharing !== account.sharing || (sharing === 'members' && memberIds.join() !== (account.memberIds ?? []).join());
  return <div className="mcp-controls">
    <div className="mcp-inline">
      <span className="mcp-inline__label">Sharing</span>
      <select aria-label="Account sharing" value={sharing} onChange={e => setSharing(e.target.value as McpAccount['sharing'])}>
        <option value="private">Only me</option><option value="members">Selected members</option><option value="space">Everyone in this space</option>
      </select>
      <button type="button" aria-label="Save sharing" className={changed ? 'mcp-btn--primary' : undefined} disabled={busy}
        onClick={() => void run(() => port.share(server.id, account.id, sharing, sharing === 'members' ? memberIds : []), 'Account sharing updated.')}>Save</button>
    </div>
    {memberError && <p role="alert" className="mcp-note">Members could not be loaded. Reopen this account to retry.</p>}
    {sharing === 'members' && <fieldset className="mcp-members"><legend className="mcp-sr">Members who may use this account</legend>{members.map(m => <label key={m.id}>
      <input type="checkbox" checked={memberIds.includes(m.id)} onChange={e => setMemberIds(e.target.checked ? [...memberIds, m.id] : memberIds.filter(id => id !== m.id))} /> {m.label}
    </label>)}</fieldset>}
    {server.auth === 'api_key' && account.status !== 'credential_definition_changed' && <form className="mcp-inline" onSubmit={e => {
      e.preventDefault();
      const form = e.currentTarget;
      const secret = String(new FormData(form).get('secret') ?? '');
      // Cleared BEFORE the await: a rejected rotate must not leave the key
      // sitting in a live input for the next person at the screen.
      form.reset();
      void run(() => port.rotateKey(server.id, account.id, secret), 'Key rotated.');
    }}>
      <span className="mcp-inline__label">API key</span>
      <input name="secret" type="password" required autoComplete="off" aria-label="Replacement API key" placeholder="Paste a new key to rotate" />
      <button disabled={busy}>Rotate key</button>
    </form>}
  </div>;
}

/** One connection: who it is, when it was used, and its two verbs, on one line. */
function ConnectionRow({ account, actions, children }: { account: McpAccount; actions?: ReactNode; children?: ReactNode }) {
  const name = account.accountLabel ?? account.label;
  return <div className="mcp-conn">
    <div className="mcp-conn__line">
      <div className="mcp-conn__who">
        <strong>{name}</strong>
        <span className={`mcp-state mcp-state--${account.status === 'connected' ? 'ok' : 'warn'} mcp-state--sm`}>{ACCOUNT_STATUS[account.status] ?? account.status.replace(/_/g, ' ')}</span>
        <span className="mcp-note">{account.scope === 'space' ? 'Shared with this Space' : account.sharing === 'space' ? 'Lent to everyone' : account.sharing === 'members' ? 'Lent to selected members' : 'Just me'} · </span>
        <span className="mcp-note">
          {account.scope === 'space' && <>connected by {account.ownerLabel ?? 'an administrator'} · </>}
          last used {when(account.lastUsedAt)}
          {account.lastRefreshAt && <> · refreshed {when(account.lastRefreshAt)}</>}
        </span>
      </div>
      {actions && <div className="mcp-actions">{actions}</div>}
    </div>
    {/* `grantedScopes` is what the provider SAID it granted. It is listed, never
        interpreted: deciding which tools it covers is the server's job (S10). */}
    {!!account.grantedScopes?.length && <details className="mcp-note mcp-conn__scopes"><summary>{account.grantedScopes.length} scope{account.grantedScopes.length === 1 ? '' : 's'} granted</summary>
      <ul className="mcp-scopes">{account.grantedScopes.map(scope => <li key={scope}>{scope}</li>)}</ul>
    </details>}
    {children}
  </div>;
}

const ACCOUNT_STATUS: Record<string, string> = {
  connected: 'Connected', needs_reconnect: 'Needs reconnect', credential_expired: 'Expired', credential_revoked: 'Revoked',
  revoked: 'Revoked', credential_definition_changed: 'Reconnect needed', credential_unavailable: 'Unavailable', access_denied: 'No access',
};

/**
 * The health result in plain words: what is wrong, where, and the likeliest
 * fix — not just the pill. The probe reports a REASON, never the transport's
 * own error text (that stays server-side), so the hints below are read off the
 * definition: a local address over https, or private networks switched off.
 */
function healthSentence(server: McpServer, report: McpTestReport | null): string[] {
  const lines: string[] = [];
  const failed = report ? !report.ok : server.health ? !server.health.ready : false;
  if (!failed) return lines;
  const reason = report?.message ?? server.health?.reason ?? '';
  const where = server.transport === 'http' ? server.url : server.command;
  if (reason === 'server_unavailable' || reason === '') {
    lines.push(`Can't reach ${where ?? server.title}. tm8 got no MCP answer from it on the last check.`);
    if (server.transport === 'http' && isPrivateHost(server.url)) {
      if (server.url?.startsWith('https://')) lines.push(`This is a local address over https. Most local MCP servers speak plain http — try ${server.url.replace(/^https:/, 'http:')}.`);
      if (!server.source?.allowPrivateNetwork) lines.push('“Allow private networks” is off, so tm8 refuses to call a localhost or LAN address. Turn it on in Edit configuration.');
    } else if (server.transport === 'http') {
      lines.push('Check the server is running and the URL path is its MCP endpoint (often /mcp).');
    }
  } else {
    lines.push(testFailure(reason));
  }
  return lines;
}

/** One tool's input schema as a parameter table: name, type, required, description. */
function ToolParams({ schema }: { schema: Record<string, unknown> | undefined }) {
  const props = schema && typeof schema.properties === 'object' && schema.properties ? schema.properties as Record<string, Record<string, unknown>> : {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required as string[] : []);
  const names = Object.keys(props);
  if (names.length === 0) return <p className="mcp-note">Takes no parameters.</p>;
  return <table className="mcp-params">
    <thead><tr><th scope="col">Parameter</th><th scope="col">Type</th><th scope="col">Description</th></tr></thead>
    <tbody>{names.map(name => {
      const p = props[name] ?? {};
      const type = Array.isArray(p.type) ? p.type.join(' | ') : typeof p.type === 'string' ? p.type
        : Array.isArray(p.enum) ? 'enum' : 'any';
      return <tr key={name}>
        <td><code>{name}</code>{required.has(name) && <span className="mcp-req" title="Required">required</span>}</td>
        <td><code>{type}{Array.isArray(p.enum) ? ` (${(p.enum as unknown[]).map(String).join(', ')})` : ''}</code></td>
        <td>{typeof p.description === 'string' ? p.description : ''}</td>
      </tr>;
    })}</tbody>
  </table>;
}

/**
 * §10.2's live connect state and its whole fallback column, in one place.
 *
 * Each row below is a row of that table:
 *  - `starting` — `mcp.oauth.begin` is in flight and no window exists yet.
 *  - `waiting` — the popup is open. "Waiting for <Provider>…", with [Cancel].
 *  - `blocked` — the browser refused the window, so the sign-in continues in
 *    THIS tab. The server already holds `return_to`, so the person comes back
 *    here afterwards; the link is the only thing that carries a user gesture
 *    the browser will honour.
 *  - `failed` — the §10.2 error table, worded by `connectFailure`. A member
 *    sees what happened; a Space admin also sees what they can do about it,
 *    the server variable to set, and the server's own diagnosis.
 */
function ConnectStatus({ connect, admin, busy, onRetry, onSettings }: {
  connect: { phase: ConnectPhase; cancel(): void; reset(): void };
  admin: boolean;
  busy: boolean;
  onRetry(): void;
  onSettings(): void;
}) {
  const phase = connect.phase;
  if (phase.kind === 'idle') return null;
  if (phase.kind === 'starting') return <p role="status" className="mcp-note">Starting sign-in with {phase.provider}&hellip;</p>;
  if (phase.kind === 'waiting') {
    return <div className="mcp-banner mcp-banner--wait" role="status">
      <p>Waiting for {phase.provider}&hellip; finish signing in in the window tm8 opened.</p>
      <button type="button" onClick={connect.cancel}>Cancel</button>
    </div>;
  }
  if (phase.kind === 'blocked') {
    return <div className="mcp-banner mcp-banner--warn" role="alert">
      <p>Your browser blocked the sign-in window. Continue in this tab instead &mdash; tm8 brings you back here when you are done.</p>
      <div className="mcp-actions">
        {/* NOT `noopener`: the same-tab path leaves this page entirely, and the
            callback completes against the server's pending row, not an opener. */}
        <a href={phase.url} rel="noreferrer">Continue to {phase.provider}</a>
        <button type="button" onClick={connect.reset}>Cancel</button>
      </div>
    </div>;
  }
  return <ConnectError failure={phase.failure} admin={admin} busy={busy} onRetry={onRetry} onSettings={onSettings} onDismiss={connect.reset} />;
}

function ConnectError({ failure, admin, busy, onRetry, onSettings, onDismiss }: {
  failure: ConnectFailure; admin: boolean; busy: boolean;
  onRetry(): void; onSettings(): void; onDismiss(): void;
}) {
  const [copied, setCopied] = useState(false);
  return <div className="mcp-banner mcp-banner--warn" role="alert">
    <p>{failure.message}</p>
    {admin && failure.adminHint && <p className="mcp-note">{failure.adminHint}</p>}
    {admin && failure.copyable !== undefined && <p className="mcp-note">
      <code>{failure.copyable}</code>{' '}
      {/* The variable NAME, which is configuration, never its value. The
          clipboard is absent on an insecure origin and can be refused on a
          secure one, and neither must read as a failed connect — so the name is
          on screen to read either way. */}
      <button type="button" onClick={() => {
        const write = navigator.clipboard?.writeText;
        if (!write) { setCopied(false); return; }
        void write.call(navigator.clipboard, failure.copyable as string).then(() => setCopied(true), () => setCopied(false));
      }}>Copy name</button>
      {copied && <span role="status"> Copied.</span>}
    </p>}
    {/* The server's own sentence, for a Space admin only: the provider's
        origin, its status and its short error code (#1296/#1328). It is folded
        away because it is a diagnosis, not an instruction. */}
    {admin && failure.cause && <details className="mcp-note"><summary>Technical detail</summary><p>{failure.cause}</p></details>}
    <div className="mcp-actions">
      {failure.retry && <button type="button" disabled={busy} onClick={onRetry}>Try again</button>}
      {admin && failure.settings && <button type="button" onClick={onSettings}>Open settings</button>}
      <button type="button" onClick={onDismiss}>Dismiss</button>
    </div>
  </div>;
}

/** How the connector signs in, as one line of the Details list. */
function signInLabel(server: McpServer): string {
  const auth = server.source?.auth;
  if (!auth || auth.type === 'none') return 'None';
  if (auth.type === 'api_key') {
    if (auth.headerName) return `API key · header ${auth.headerName}${auth.prefix === 'Bearer' ? ' (Bearer)' : ''}`;
    return `API key · env ${auth.envKey ?? 'API_KEY'}`;
  }
  return auth.issuer ? `OAuth · ${auth.issuer}` : 'OAuth';
}

/** Who added the connector and when — the entity envelope's facts, which the catalog row does not carry. */
export interface ConnectorProvenance { createdBy?: string | null; createdAt?: string | null }

export interface ConnectorDetailProps {
  server: McpServer;
  port: McpPort;
  admin: boolean;
  busy: boolean;
  run(action: () => Promise<unknown>, success: string): Promise<void>;
  /** Called after the connector is deleted, so the host can close the view it was drawn in. */
  onDeleted?(): void;
  provenance?: ConnectorProvenance;
  /** Sections only one surface draws (the entity page's Used by and Recent calls), placed before the danger zone. */
  extra?: ReactNode;
}

/**
 * THE CONNECTOR, in the order a person asks about it: is it working, the
 * connection they own, the connection the Space owns, what tools it has, how
 * it is configured, and only then the ways to break it.
 *
 * It is the BODY both surfaces draw — the Connectors page's row drawer and the
 * `mcp_server` entity page — so the two can never disagree about a connector.
 */
export function ConnectorDetail({ server, port, admin, busy, run, onDeleted, provenance, extra }: ConnectorDetailProps) {
  const [report, setReport] = useState<McpTestReport | null>(null);
  const [confirming, setConfirming] = useState<{ kind: 'disconnect'; account: McpAccount } | { kind: 'gate'; gate: string; open: boolean } | { kind: 'delete' } | { kind: 'disable' } | { kind: 'config'; input: McpDefinition } | null>(null);
  const [editing, setEditing] = useState(false);
  const [typed, setTyped] = useState('');
  const [adding, setAdding] = useState(false);
  const [scope, setScope] = useState<McpCredentialScope>('member');

  /**
   * §10.2. `run` is the page's single-action wrapper: it reports one sentence
   * and refreshes the catalog. A connect is not one action — it is a `begin`,
   * then a window the person uses, then a message back — so the popup flow owns
   * its own phase and reaches for `run` only at the END, to announce the
   * connection and pull the fresh row in.
   */
  const announce = useCallback((result: { provider: string; accountLabel?: string }) => {
    setAdding(false);
    void run(async () => undefined, result.accountLabel
      ? `${result.provider} connected as ${result.accountLabel}.`
      : `${result.provider} connected.`);
  }, [run]);
  const connect = useConnect({ port, admin, onConnected: announce });

  const definition = server.source;
  const google = isGoogleConnector(definition);
  const base = rowStatusOf(server);
  /**
   * `provider_blocked` has no server-side readiness reason — only a failed
   * `mcp.oauth.begin` can produce it (`connector-rows.ts`), and this is the one
   * surface that has just made that call. So the DCR 403 is shown as the §10.0
   * row it is, rather than only as an error line under the form.
   */
  const row = connect.phase.kind === 'failed' && connect.phase.failure.status
    ? { ...base, status: connect.phase.failure.status }
    : base;
  const live = server.accounts.filter(account => account.status !== 'revoked');
  const mine = live.filter(account => account.scope !== 'space' && account.canManage);
  const shared = live.filter(account => account.scope === 'space');
  const lent = live.filter(account => account.scope !== 'space' && !account.canManage);
  const usable = live.find(account => account.canUse && account.status === 'connected');

  /**
   * S12: the view tests on open for a first-party connection, because that is
   * where `unavailableTools` comes from and the call is in-process and cheap.
   * A remote connector is NOT probed on open — that would be an outbound
   * request to a provider every time someone clicked a row.
   */
  const usableId = usable?.id;
  useEffect(() => {
    let active = true;
    setReport(null);
    if (!definition?.firstParty || !usableId) return;
    void port.test({ serverId: server.id, credentialId: usableId }).then(
      result => { if (active) setReport(result); },
      () => { /* The Tools list falls back to the stored health check. */ },
    );
    return () => { active = false; };
    // The connection's ID, not the object: `usable` is recomputed every
    // render, so depending on it would re-run this effect, which sets state,
    // which renders again — a loop that only a first-party connector reaches.
  }, [port, server.id, definition?.firstParty, usableId]);

  const tools = report?.tools ?? server.health?.tools ?? [];
  const unavailable = report?.unavailableTools ?? [];
  const unavailableByName = new Map(unavailable.map(tool => [tool.name, tool.scopes]));
  /** S9: a gated tool is listed only while its gate is open, and never as "missing". */
  const gates = definition?.gates ?? {};
  const closedGateTools = new Set(Object.entries(gates).flatMap(([gate, open]) => open === false ? (GATE_TOOLS[gate] ?? []) : []));
  const shownTools = tools.filter(tool => !closedGateTools.has(tool.name));
  const checked = ago(server.health?.checkedAt);
  const health = healthSentence(server, report);
  const gateToggles = admin ? Object.entries(GATE_LABELS).filter(([gate]) => gate in gates || GATE_APPLIES(server, gate)) : [];

  async function patchDefinition(patch: Parameters<McpPort['patch']>[1], success: string) {
    await run(() => port.patch(server, patch), success);
  }
  const startAdding = (as: McpCredentialScope) => { setAdding(true); setScope(as); };

  return <div className="mcp-detail">
    <div className="mcp-detail__status">
      <StatusPill server={server} row={row} />
      <span className="mcp-note">{checked ? `Checked ${checked}` : 'Not tested yet'}</span>
      <div className="mcp-detail__grow" />
      <button type="button" disabled={busy || (server.auth !== 'none' && !usable)} onClick={() => void run(async () => {
        const result = await port.test({ serverId: server.id, ...(usable ? { credentialId: usable.id } : {}) });
        setReport(result);
        if (!result.ok) throw new McpUiError(testFailure(result.message));
      }, 'Connection tested.')}>Test connection</button>
    </div>
    {health.length > 0 && <div className="mcp-health" role="status">{health.map(line => <p key={line}>{line}</p>)}</div>}
    {server.description && <p className="mcp-detail__desc">{server.description}</p>}

    {/* S10/S12: a partial grant is ACTIVE. The banner states the gap and offers
        the reconnect that closes it; Google then asks only for what is missing. */}
    {unavailable.length > 0 && <div className="mcp-banner mcp-banner--warn" role="status">
      <p>⚠ Reconnect to restore {unavailable.length} tool{unavailable.length === 1 ? '' : 's'}.</p>
      <button type="button" disabled={busy || !usable} onClick={() => startAdding(usable?.scope ?? 'member')}>Reconnect</button>
    </div>}

    <Section title="Your connection" actions={server.auth !== 'none' &&
      <button type="button" className={mine.length ? undefined : 'mcp-btn--primary'} disabled={busy || !server.approved || !server.enabled} onClick={() => startAdding('member')}>
        {mine.length ? '+ Add another account' : 'Connect'}
      </button>}>
      {server.auth === 'none' && <p className="mcp-note">This connector needs no account: everyone in the Space uses it as is.</p>}
      {server.auth !== 'none' && mine.length === 0 && <p className="mcp-note">You haven&rsquo;t connected an account here.</p>}
      {mine.map(account => <ConnectionRow key={account.id} account={account} actions={<>
        <button type="button" disabled={busy} onClick={() => startAdding('member')}>Reconnect</button>
        <button type="button" className="mcp-btn--quiet" disabled={busy} onClick={() => setConfirming({ kind: 'disconnect', account })}>Disconnect</button>
      </>}>
        <ConnectionControls account={account} server={server} port={port} busy={busy} run={run} />
      </ConnectionRow>)}
      {lent.map(account => <p className="mcp-note" key={account.id}>
        {account.canUse
          ? `${account.label} is shared with you by ${account.ownerLabel ?? 'another member'}. Its owner manages it.`
          : `${account.label} belongs to ${account.ownerLabel ?? 'another member'} and is not shared with you.`}
      </p>)}

      {/* While a connect is in flight the form gives way to its status: §10.2
          shows the person ONE thing at a time — "Waiting for Google…", the
          same-tab link, or the error with [Try again], which brings this back. */}
      {adding && connect.phase.kind === 'idle' && server.auth !== 'none' && <form className="mcp-add-account" onSubmit={e => {
        e.preventDefault();
        const form = e.currentTarget;
        const data = new FormData(form);
        const label = String(data.get('label'));
        const secret = String(data.get('secret') ?? '');
        if (server.auth !== 'api_key') { void connect.start(server, { label, scope }); return; }
        // Cleared BEFORE the await: a rejected create must not leave the key
        // sitting in a live input for the next person at the screen.
        form.reset();
        void run(async () => {
          await port.createKey(server.id, label, secret, scope);
          setAdding(false);
        }, 'Connection added.');
      }}>
        {/* A first-party Google connection is NAMED BY GOOGLE: `accountLabel` is
            filled from userinfo at the callback (#1323). Making someone invent a
            label for it first is a question with no useful answer, so the
            connector's own name is offered and the real account arrives after. */}
        <label><span>Account label</span><input name="label" required autoComplete="off" defaultValue={google ? server.title : ''} placeholder="e.g. Work" /></label>
        {google && <p className="mcp-note">Google supplies the account name once you sign in.</p>}
        {server.auth === 'api_key' && <label><span>API key</span><input name="secret" type="password" required autoComplete="off" /></label>}
        {/* §10.2 step 2: only a Space admin is offered the Space-owned scope.
            A member's connection is always their own. */}
        {admin && <fieldset className="mcp-seg"><legend>Who uses this connection</legend>
          <label><input type="radio" name="scope" value="member" checked={scope === 'member'} onChange={() => setScope('member')} /> Just me</label>
          <label><input type="radio" name="scope" value="space" checked={scope === 'space'} onChange={() => setScope('space')} /> Shared with this Space</label>
        </fieldset>}
        {admin && scope === 'space' && <p className="mcp-note">Everyone&rsquo;s sessions in this Space will act as this account.</p>}
        <div className="mcp-actions">
          <button type="submit" className="mcp-btn--primary" disabled={busy}>{server.auth === 'api_key' ? 'Save connection' : 'Continue to sign-in'}</button>
          <button type="button" className="mcp-btn--quiet" onClick={() => setAdding(false)}>Cancel</button>
        </div>
      </form>}
      <ConnectStatus connect={connect} admin={admin} busy={busy}
        onRetry={() => { connect.reset(); setAdding(true); }}
        onSettings={() => { connect.reset(); setEditing(true); }} />
    </Section>

    {shared.length > 0 && <Section title="Shared connection">
      <p className="mcp-note">Everyone&rsquo;s sessions in this Space act as this account.</p>
      {shared.map(account => <ConnectionRow key={account.id} account={account} actions={admin && <>
        <button type="button" disabled={busy} onClick={() => startAdding('space')}>Replace</button>
        <button type="button" className="mcp-btn--quiet" disabled={busy} onClick={() => setConfirming({ kind: 'disconnect', account })}>Disconnect</button>
      </>}>
        {admin && account.canManage && <ConnectionControls account={account} server={server} port={port} busy={busy} run={run} />}
      </ConnectionRow>)}
    </Section>}

    <Section title="Tools" {...(shownTools.length ? { count: shownTools.length } : {})}>
      {shownTools.length === 0 && <p className="mcp-note">No tools discovered yet. Test the connection to list them.</p>}
      {shownTools.length > 0 && <ul className="mcp-tools">
        {shownTools.map(tool => {
          const missing = unavailableByName.get(tool.name);
          const schema = tool.inputSchema;
          return <li key={tool.name} className={missing ? 'mcp-tool--unavailable' : undefined}>
            <details>
              <summary>
                <code>{tool.name}</code>
                {tool.description && <span className="mcp-tool__desc">{tool.description}</span>}
              </summary>
              <ToolParams schema={schema} />
            </details>
            {missing && <span className="mcp-note">Needs more Google access: {missing.join(', ') || 'an additional scope'}</span>}
          </li>;
        })}
      </ul>}
      {/* S9: the gate is admin-only, is part of the fingerprint, and the confirm
          comes first in BOTH directions. */}
      {gateToggles.map(([gate, label]) => {
        const open = gates[gate] !== false;
        return <label key={gate} className="mcp-toggle">
          <input type="checkbox" checked={open} disabled={busy} onChange={() => setConfirming({ kind: 'gate', gate, open: !open })} /> {label}
        </label>;
      })}
    </Section>

    <Section title="Details" actions={admin && server.canManage &&
      <button type="button" onClick={() => setEditing(!editing)}>{editing ? 'Cancel edit' : 'Edit configuration'}</button>}>
      {!editing && <dl className="mcp-facts">
        <dt>Type</dt><dd>{typeLabel(server)} · {server.transport === 'http' ? 'HTTP' : 'stdio'}</dd>
        <dt>{server.transport === 'http' ? 'URL' : 'Command'}</dt>
        <dd><code>{server.transport === 'http' ? server.url : [server.command, ...(server.args ?? [])].join(' ')}</code></dd>
        <dt>Sign-in</dt><dd>{signInLabel(server)}</dd>
        {server.transport === 'http' && <><dt>Private networks</dt><dd>{definition?.allowPrivateNetwork ? 'Allowed' : 'Blocked'}</dd></>}
        {definition && <><dt>Tool prefix</dt><dd><code>mcp__{mcpServerKey(definition)}__</code></dd></>}
        <dt>Access</dt><dd>{accessLabel(server)}</dd>
        {/* defaultOn is SPACE-WIDE: it joins the default set of every chat and
            session in this Space, for every member. Labelling it "new chats and
            sessions" without saying whose was the D4-shaped falsehood this page
            exists to stop. */}
        <dt>Default</dt><dd>{admin
          ? <label className="mcp-toggle"><input type="checkbox" checked={definition?.defaultOn === true} disabled={busy}
            onChange={e => void patchDefinition({ defaultOn: e.target.checked }, 'Space default updated.')} /> On by default for everyone in this Space</label>
          : definition?.defaultOn ? 'On for everyone in this Space' : 'Off'}</dd>
        <dt>External clients</dt><dd>{admin
          ? <label className="mcp-toggle"><input type="checkbox" checked={definition?.allowExternalClients === true} disabled={busy}
            onChange={e => void patchDefinition({ allowExternalClients: e.target.checked }, 'External client access updated.')} /> Available to external MCP clients</label>
          : definition?.allowExternalClients ? 'Available' : 'Not available'}</dd>
        {(provenance?.createdBy || provenance?.createdAt) && <><dt>Added</dt>
          <dd>{provenance.createdBy ? `by ${provenance.createdBy}` : ''}{provenance.createdBy && provenance.createdAt ? ' · ' : ''}{provenance.createdAt ? when(provenance.createdAt) : ''}</dd></>}
      </dl>}
      {editing && <ConnectorForm server={server} busy={busy} onSave={async input => {
        // §10.3: a field that changes how the connector SIGNS IN bumps the
        // security revision, and every connection then reads
        // `credential_definition_changed`. The person is told how many before
        // the write, not after it.
        if (changesSignIn(server, input)) { setConfirming({ kind: 'config', input }); return; }
        await run(() => port.patch(server, definitionPatch(input)), 'Connector saved.');
        setEditing(false);
      }} />}
    </Section>

    {extra}

    {admin && <section className="mcp-danger" aria-label="Danger zone">
      <div>
        <strong>Danger zone</strong>
        <p className="mcp-note">{server.enabled ? 'Disabling stops every chat and session loading its tools.' : 'This connector is disabled.'} Deleting revokes every connection.</p>
      </div>
      <div className="mcp-actions">
        <button type="button" disabled={busy} onClick={() => setConfirming({ kind: 'disable' })}>{server.enabled ? 'Disable connector' : 'Enable connector'}</button>
        <button type="button" className="mcp-btn--danger" disabled={busy} onClick={() => { setTyped(''); setConfirming({ kind: 'delete' }); }}>Delete connector</button>
      </div>
    </section>}

    {confirming?.kind === 'disconnect' && (() => {
      const copy = disconnectCopy(server, confirming.account);
      return <div className="mcp-confirm" role="alertdialog" aria-label="Confirm disconnect">
        <p>{copy.confirm}</p>
        {copy.google && <p><a href={GOOGLE_PERMISSIONS} target="_blank" rel="noopener noreferrer">Google&rsquo;s permissions page</a></p>}
        <div className="mcp-actions">
          <button type="button" className="mcp-btn--danger" disabled={busy} onClick={() => void run(async () => {
            await port.revoke(server.id, confirming.account.id);
            setConfirming(null);
          }, copy.google
            ? "tm8 stops using this connection. To remove tm8's access from your Google account entirely, use Google's permissions page."
            : 'Connection disconnected.')}>Confirm disconnect</button>
          <button type="button" className="mcp-btn--quiet" onClick={() => setConfirming(null)}>Cancel</button>
        </div>
      </div>;
    })()}

    {confirming?.kind === 'gate' && <div className="mcp-confirm" role="alertdialog" aria-label="Confirm tool change">
      <p>This changes what {server.title} can do. {live.length} connection{live.length === 1 ? '' : 's'} will need to reconnect.</p>
      <div className="mcp-actions">
        <button type="button" className="mcp-btn--primary" disabled={busy} onClick={() => {
          const gate = confirming.gate, open = confirming.open;
          setConfirming(null);
          void patchDefinition({ gates: { ...gates, [gate]: open } }, open ? 'Tool enabled.' : 'Tool disabled.');
        }}>Confirm change</button>
        <button type="button" className="mcp-btn--quiet" onClick={() => setConfirming(null)}>Cancel</button>
      </div>
    </div>}

    {confirming?.kind === 'disable' && <div className="mcp-confirm" role="alertdialog" aria-label="Confirm connector state">
      <p>{server.enabled
        ? `Disable ${server.title}? Chats and sessions stop loading its tools immediately.`
        : `Enable ${server.title}? Its tools become available again to everyone who has a connection.`}</p>
      <div className="mcp-actions">
        <button type="button" className="mcp-btn--primary" disabled={busy} onClick={() => { setConfirming(null); void patchDefinition({ enabled: !server.enabled }, server.enabled ? 'Connector disabled.' : 'Connector enabled.'); }}>Confirm</button>
        <button type="button" className="mcp-btn--quiet" onClick={() => setConfirming(null)}>Cancel</button>
      </div>
    </div>}

    {confirming?.kind === 'config' && <div className="mcp-confirm" role="alertdialog" aria-label="Confirm sign-in change">
      <p>This changes how {server.title} signs in. {live.length} connection{live.length === 1 ? '' : 's'} will need to reconnect.</p>
      <div className="mcp-actions">
        <button type="button" className="mcp-btn--primary" disabled={busy} onClick={() => {
          const input = confirming.input;
          setConfirming(null);
          void run(async () => { await port.patch(server, definitionPatch(input)); setEditing(false); }, 'Connector saved.');
        }}>Confirm change</button>
        <button type="button" className="mcp-btn--quiet" onClick={() => setConfirming(null)}>Cancel</button>
      </div>
    </div>}

    {confirming?.kind === 'delete' && <div className="mcp-confirm mcp-confirm--danger" role="alertdialog" aria-label="Confirm delete">
      <p>Delete {server.title}? {live.length} connection{live.length === 1 ? '' : 's'} will be revoked.</p>
      <div className="mcp-inline">
        <input aria-label="Type the connector’s name to confirm" placeholder={server.title} value={typed} onChange={e => setTyped(e.target.value)} autoComplete="off" />
        <button type="button" className="mcp-btn--danger" disabled={busy || typed !== server.title} onClick={() => void run(async () => {
          await port.remove(server);
          setConfirming(null);
          onDeleted?.();
        }, 'Connector deleted.')}>Delete connector</button>
        <button type="button" className="mcp-btn--quiet" onClick={() => setConfirming(null)}>Cancel</button>
      </div>
    </div>}
  </div>;
}

/** The Connectors page's row drawer: the connector's name and a close, over the shared detail body. */
export function ConnectorDrawer({ server, port, admin, busy, run, onClose }: {
  server: McpServer;
  port: McpPort;
  admin: boolean;
  busy: boolean;
  run(action: () => Promise<unknown>, success: string): Promise<void>;
  onClose(): void;
}) {
  return <aside className="mcp-drawer" aria-label={`${server.title} connector`}>
    <header className="mcp-drawer__head">
      <ConnectorLogo logo={serverLogo(server.source)} title={server.title} />
      <div>
        <h3>{server.title}</h3>
        <p className="mcp-note">{typeLabel(server)} · {accessLabel(server)}</p>
      </div>
      <button type="button" className="mcp-drawer__close" onClick={onClose} aria-label="Close connector details">×</button>
    </header>
    <ConnectorDetail server={server} port={port} admin={admin} busy={busy} run={run} onDeleted={onClose} />
  </aside>;
}

/**
 * The gates this build can draw a toggle for, and the tools each one covers.
 *
 * It mirrors `MCP_CATALOG`'s `gates` (contract/mcp-catalog.ts) rather than
 * reading it, because a connector added from a catalog entry keeps only
 * `definition.gates` — the labels stay on the entry. Keeping the pair here
 * means an unknown gate key draws no toggle at all instead of a checkbox
 * labelled with a raw identifier.
 */
const GATE_LABELS: Record<string, string> = { gmailSend: 'Allow sending email' };
/**
 * The form's fields as a definition patch. `port.patch` merges onto the STORED
 * definition, so the fields the form has no input for (catalogId, serverKey,
 * firstParty, defaultOn, allowExternalClients, gates) survive untouched —
 * which is the whole reason the admin toggles do not go through `port.update`.
 */
function definitionPatch(input: McpDefinition): Partial<import('@tm8/contract').McpServerDefinition> {
  const slot = input.secretSlot || (input.transport === 'http' ? 'Authorization' : 'API_KEY');
  return {
    name: input.title, provenance: input.description || undefined, transport: input.transport,
    ...(input.transport === 'http'
      ? { url: input.url, command: undefined, args: undefined }
      : { command: input.command, args: input.args ?? [], url: undefined, stdioTrusted: input.trustedCode ?? false }),
    allowPrivateNetwork: input.allowPrivateNetwork ?? false,
    envKeys: input.auth === 'api_key' && input.transport === 'stdio' ? [slot] : [],
    headerKeys: input.auth === 'api_key' && input.transport === 'http' ? [slot] : [],
    auth: input.auth === 'none' ? { type: 'none' } : input.auth === 'api_key'
      ? { type: 'api_key', ...(input.transport === 'http' ? { headerName: slot, prefix: input.prefix ?? 'Bearer' } : { envKey: slot }) }
      : { type: 'oauth2', ...(input.issuer ? { issuer: input.issuer } : {}), ...(input.authorizationUrl ? { authorizationUrl: input.authorizationUrl } : {}), ...(input.tokenUrl ? { tokenUrl: input.tokenUrl } : {}), ...(input.clientId ? { clientId: input.clientId } : {}), ...(input.clientSecretEnv ? { clientSecretEnv: input.clientSecretEnv } : {}), scopes: input.scopes ?? [] },
  };
}

/** Does this edit touch a field in the definition FINGERPRINT (B1)? If so, every connection must reconnect. */
function changesSignIn(server: McpServer, input: McpDefinition): boolean {
  const before = server.source;
  if (!before) return true;
  if ((before.auth.type === 'oauth2' ? 'oauth' : before.auth.type) !== input.auth) return true;
  if (before.transport !== input.transport) return true;
  if (input.transport === 'http' ? before.url !== input.url : before.command !== input.command) return true;
  if (before.auth.type === 'oauth2') {
    const scopes = (before.auth.scopes ?? []).join(' ');
    if ((before.auth.issuer ?? '') !== input.issuer || (before.auth.clientId ?? '') !== (input.clientId ?? '')) return true;
    if (scopes !== (input.scopes ?? []).join(' ')) return true;
  }
  return false;
}
const GATE_TOOLS: Record<string, string[]> = { gmailSend: ['send_message'] };
/** A gate absent from the definition is OPEN (`mcpGateOpen`), so only offer one the connector actually has. */
const GATE_APPLIES = (server: McpServer, gate: string): boolean =>
  gate === 'gmailSend' && (server.source?.catalogId ?? '') === 'google.gmail';
