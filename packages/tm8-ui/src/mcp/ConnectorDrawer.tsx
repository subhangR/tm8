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
 *  - S10/S12. A partial Google grant is not a broken connection: it stays
 *    `ready`, and the gap shows here, from `unavailableTools` on
 *    `mcp.servers.test`. The UI never computes scope coverage — if the server
 *    does not report a gap, none is drawn.
 */
import { useEffect, useState } from 'react';
import type { McpCredentialScope } from '@tm8/contract';
import { ConnectorForm } from './ConnectorForm';
import { ConnectorLogo } from './connector-logos';
import { accessLabel, isGoogleConnector, rowStatusOf, statusLabel, typeLabel, STATUS_ROWS } from './connector-rows';
import { McpUiError, testFailure } from './errors';
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
  return Number.isNaN(at.getTime()) ? 'unknown' : at.toLocaleString();
}

function ConnectionFacts({ account }: { account: McpAccount }) {
  return <dl className="mcp-facts">
    <dt>Account</dt><dd>{account.accountLabel ?? account.label}</dd>
    {account.scope === 'space' && <><dt>Connected by</dt><dd>{account.ownerLabel ?? 'an administrator'}</dd></>}
    <dt>Last used</dt><dd>{when(account.lastUsedAt)}</dd>
    {account.lastRefreshAt && <><dt>Last refreshed</dt><dd>{when(account.lastRefreshAt)}</dd></>}
    {/* `grantedScopes` is what the provider SAID it granted. It is listed, never
        interpreted: deciding which tools it covers is the server's job (S10). */}
    {!!account.grantedScopes?.length && <><dt>Scopes granted</dt><dd><ul className="mcp-scopes">{account.grantedScopes.map(scope => <li key={scope}>{scope}</li>)}</ul></dd></>}
  </dl>;
}

/**
 * The controls for a connection THIS VIEWER manages: who may use it, and (for
 * an API key) replacing the secret.
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
  return <div className="mcp-form">
    <label>Account sharing<select value={sharing} onChange={e => setSharing(e.target.value as McpAccount['sharing'])}>
      <option value="private">Only me</option><option value="members">Selected members</option><option value="space">Everyone in this space</option>
    </select></label>
    {memberError && <p role="alert">Members could not be loaded. Reopen this account to retry.</p>}
    {sharing === 'members' && <fieldset><legend>Members who may use this account</legend>{members.map(m => <label key={m.id}><span>
      <input type="checkbox" checked={memberIds.includes(m.id)} onChange={e => setMemberIds(e.target.checked ? [...memberIds, m.id] : memberIds.filter(id => id !== m.id))} /> {m.label}
    </span></label>)}</fieldset>}
    <button type="button" disabled={busy} onClick={() => void run(() => port.share(server.id, account.id, sharing, sharing === 'members' ? memberIds : []), 'Account sharing updated.')}>Save sharing</button>
    {server.auth === 'api_key' && account.status !== 'credential_definition_changed' && <form className="mcp-form" onSubmit={e => {
      e.preventDefault();
      const form = e.currentTarget;
      const secret = String(new FormData(form).get('secret') ?? '');
      // Cleared BEFORE the await: a rejected rotate must not leave the key
      // sitting in a live input for the next person at the screen.
      form.reset();
      void run(() => port.rotateKey(server.id, account.id, secret), 'Key rotated.');
    }}>
      <label>Replacement API key<input name="secret" type="password" required autoComplete="off" /></label>
      <button disabled={busy}>Rotate key</button>
    </form>}
  </div>;
}

export function ConnectorDrawer({ server, port, admin, busy, run, onClose }: {
  server: McpServer;
  port: McpPort;
  admin: boolean;
  busy: boolean;
  run(action: () => Promise<unknown>, success: string): Promise<void>;
  onClose(): void;
}) {
  const [report, setReport] = useState<McpTestReport | null>(null);
  const [confirming, setConfirming] = useState<{ kind: 'disconnect'; account: McpAccount } | { kind: 'gate'; gate: string; open: boolean } | { kind: 'delete' } | { kind: 'disable' } | { kind: 'config'; input: McpDefinition } | null>(null);
  const [editing, setEditing] = useState(false);
  const [typed, setTyped] = useState('');
  const [adding, setAdding] = useState(false);
  const [scope, setScope] = useState<McpCredentialScope>('member');
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);

  const definition = server.source;
  const google = isGoogleConnector(definition);
  const row = rowStatusOf(server);
  const live = server.accounts.filter(account => account.status !== 'revoked');
  const mine = live.filter(account => account.scope !== 'space' && account.canManage);
  const shared = live.filter(account => account.scope === 'space');
  const lent = live.filter(account => account.scope !== 'space' && !account.canManage);
  const usable = live.find(account => account.canUse && account.status === 'connected');

  /**
   * S12: the drawer tests on open for a first-party connection, because that is
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

  async function patchDefinition(patch: Parameters<McpPort['patch']>[1], success: string) {
    await run(() => port.patch(server, patch), success);
  }

  return <aside className="mcp-drawer" aria-label={`${server.title} connector`}>
    <header className="mcp-drawer__head">
      <ConnectorLogo logo={definition?.catalogId?.replace(/\./g, '-')} title={server.title} />
      <div>
        <h3>{server.title}</h3>
        <p className="mcp-note">{typeLabel(server)} · {accessLabel(server)}</p>
      </div>
      <button type="button" className="mcp-drawer__close" onClick={onClose} aria-label="Close connector details">×</button>
    </header>

    <p className={`mcp-status mcp-status--${STATUS_ROWS[row.status].tone}`}>
      <span aria-hidden="true">{STATUS_ROWS[row.status].icon}</span> {statusLabel(row.status, { name: server.title, statusReason: row.statusReason ?? null })}
    </p>
    {server.description && <p>{server.description}</p>}

    {/* S10/S12: a partial grant is ACTIVE. The banner states the gap and offers
        the reconnect that closes it; Google then asks only for what is missing. */}
    {unavailable.length > 0 && <div className="mcp-banner mcp-banner--warn" role="status">
      <p>⚠ Reconnect to restore {unavailable.length} tool{unavailable.length === 1 ? '' : 's'}.</p>
      <button type="button" disabled={busy || !usable} onClick={() => { setAdding(true); setScope(usable?.scope ?? 'member'); }}>Reconnect</button>
    </div>}

    <section className="mcp-drawer__group">
      <h4>Your connection</h4>
      {mine.length === 0 && <p className="mcp-note">You haven&rsquo;t connected an account here.</p>}
      {mine.map(account => <div className="mcp-connection" key={account.id}>
        <ConnectionFacts account={account} />
        <div className="mcp-actions">
          <button type="button" disabled={busy} onClick={() => { setAdding(true); setScope('member'); }}>Reconnect</button>
          <button type="button" disabled={busy} onClick={() => setConfirming({ kind: 'disconnect', account })}>Disconnect</button>
        </div>
        <ConnectionControls account={account} server={server} port={port} busy={busy} run={run} />
      </div>)}
      {server.auth !== 'none' && <button type="button" disabled={busy || !server.approved || !server.enabled} onClick={() => { setAdding(true); setScope('member'); }}>
        {mine.length ? '+ Add another account' : 'Connect'}
      </button>}
      {lent.map(account => <p className="mcp-note" key={account.id}>
        {account.canUse
          ? `${account.label} is shared with you by ${account.ownerLabel ?? 'another member'}. Its owner manages it.`
          : `${account.label} belongs to ${account.ownerLabel ?? 'another member'} and is not shared with you.`}
      </p>)}
    </section>

    {shared.length > 0 && <section className="mcp-drawer__group">
      <h4>Shared connection</h4>
      <p className="mcp-note">Everyone&rsquo;s sessions in this Space act as this account.</p>
      {shared.map(account => <div className="mcp-connection" key={account.id}>
        <ConnectionFacts account={account} />
        {admin && <>
          <div className="mcp-actions">
            <button type="button" disabled={busy} onClick={() => { setAdding(true); setScope('space'); }}>Replace</button>
            <button type="button" disabled={busy} onClick={() => setConfirming({ kind: 'disconnect', account })}>Disconnect</button>
          </div>
          {account.canManage && <ConnectionControls account={account} server={server} port={port} busy={busy} run={run} />}
        </>}
      </div>)}
    </section>}

    {adding && server.auth !== 'none' && <form className="mcp-form" onSubmit={e => {
      e.preventDefault();
      const form = e.currentTarget;
      const data = new FormData(form);
      const label = String(data.get('label'));
      const secret = String(data.get('secret') ?? '');
      form.reset();
      void run(async () => {
        if (server.auth === 'api_key') await port.createKey(server.id, label, secret, scope);
        else {
          const response = await port.startOAuth(server.id, label, scope);
          const url = new URL(response.authorizationUrl);
          if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new McpUiError('This provider returned an address tm8 will not open.');
          setOauthUrl(url.href);
        }
        setAdding(false);
      }, server.auth === 'api_key' ? 'Connection added.' : 'Authorization is ready.');
    }}>
      <label>Account label<input name="label" required autoComplete="off" /></label>
      {server.auth === 'api_key' && <label>API key<input name="secret" type="password" required autoComplete="off" /></label>}
      {/* §10.2 step 2: only a Space admin is offered the Space-owned scope.
          A member's connection is always their own. */}
      {admin && <fieldset className="mcp-scope"><legend>Who uses this connection</legend>
        <label><span><input type="radio" name="scope" value="member" checked={scope === 'member'} onChange={() => setScope('member')} /> Just me</span></label>
        <label><span><input type="radio" name="scope" value="space" checked={scope === 'space'} onChange={() => setScope('space')} /> Shared with this Space</span></label>
        {scope === 'space' && <p className="mcp-note">Everyone&rsquo;s sessions in this Space will act as this account.</p>}
      </fieldset>}
      <div className="mcp-actions">
        <button type="submit" disabled={busy}>{server.auth === 'api_key' ? 'Save connection' : 'Continue to sign-in'}</button>
        <button type="button" onClick={() => setAdding(false)}>Cancel</button>
      </div>
    </form>}
    {oauthUrl && <div className="mcp-actions"><a href={oauthUrl} rel="noreferrer">Continue authorization</a></div>}

    <section className="mcp-drawer__group">
      <h4>Tools</h4>
      {tools.length === 0 && <p className="mcp-note">No tools discovered yet. Test the connection to list them.</p>}
      {tools.length > 0 && <ul className="mcp-tools">
        {tools.filter(tool => !closedGateTools.has(tool.name)).map(tool => {
          const missing = unavailableByName.get(tool.name);
          return <li key={tool.name} className={missing ? 'mcp-tool--unavailable' : undefined}>
            <strong>{tool.name}</strong>
            {tool.description && <p>{tool.description}</p>}
            {missing && <p className="mcp-note">Needs more Google access: {missing.join(', ') || 'an additional scope'}</p>}
          </li>;
        })}
      </ul>}
      <div className="mcp-actions">
        <button type="button" disabled={busy || (server.auth !== 'none' && !usable)} onClick={() => void run(async () => {
          const result = await port.test({ serverId: server.id, ...(usable ? { credentialId: usable.id } : {}) });
          setReport(result);
          if (!result.ok) throw new McpUiError(testFailure(result.message));
        }, 'Connection tested.')}>Test connection</button>
      </div>
      {/* S9: the gate is admin-only, is part of the fingerprint, and the confirm
          comes first in BOTH directions. */}
      {admin && Object.entries(GATE_LABELS).filter(([gate]) => gate in gates || GATE_APPLIES(server, gate)).map(([gate, label]) => {
        const open = gates[gate] !== false;
        return <label key={gate} className="mcp-toggle"><span>
          <input type="checkbox" checked={open} disabled={busy} onChange={() => setConfirming({ kind: 'gate', gate, open: !open })} /> {label}
        </span></label>;
      })}
    </section>

    {admin && <section className="mcp-drawer__group">
      <h4>Defaults</h4>
      {/* defaultOn is SPACE-WIDE: it joins the default set of every chat and
          session in this Space, for every member. Labelling it "new chats and
          sessions" without saying whose was the D4-shaped falsehood this page
          exists to stop. */}
      <label className="mcp-toggle"><span>
        <input type="checkbox" checked={definition?.defaultOn === true} disabled={busy}
          onChange={e => void patchDefinition({ defaultOn: e.target.checked }, 'Space default updated.')} />
        On by default for everyone in this Space
      </span></label>
      <label className="mcp-toggle"><span>
        <input type="checkbox" checked={definition?.allowExternalClients === true} disabled={busy}
          onChange={e => void patchDefinition({ allowExternalClients: e.target.checked }, 'External client access updated.')} />
        Available to external MCP clients
      </span></label>
    </section>}

    <section className="mcp-drawer__group">
      <h4>Activity</h4>
      {/* The per-connector call list (§10.1 Activity, §10.8) reads
          `mcp.audit.list` and is built by the audit-views task, which owns the
          member-vs-admin scoping ruling (S11). Saying so beats an empty table
          that looks like "no calls". */}
      <p className="mcp-note">Connector call history arrives with the audit views.</p>
    </section>

    {admin && server.canManage && <section className="mcp-drawer__group">
      <h4>Configuration</h4>
      <p className="mcp-note">{server.transport === 'http' ? server.url : server.command}</p>
      <button type="button" onClick={() => setEditing(!editing)}>{editing ? 'Cancel edit' : 'Edit configuration'}</button>
      {editing && <ConnectorForm server={server} busy={busy} onSave={async input => {
        // §10.3: a field that changes how the connector SIGNS IN bumps the
        // security revision, and every connection then reads
        // `credential_definition_changed`. The admin is told how many before
        // the write, not after it.
        if (changesSignIn(server, input)) { setConfirming({ kind: 'config', input }); return; }
        await run(() => port.patch(server, definitionPatch(input)), 'Connector saved.');
        setEditing(false);
      }} />}
    </section>}

    {admin && <section className="mcp-drawer__group mcp-drawer__group--danger">
      <h4>Danger zone</h4>
      <div className="mcp-actions">
        <button type="button" disabled={busy} onClick={() => setConfirming({ kind: 'disable' })}>{server.enabled ? 'Disable connector' : 'Enable connector'}</button>
        <button type="button" disabled={busy} onClick={() => { setTyped(''); setConfirming({ kind: 'delete' }); }}>Delete connector</button>
      </div>
    </section>}

    {confirming?.kind === 'disconnect' && (() => {
      const copy = disconnectCopy(server, confirming.account);
      return <div className="mcp-confirm" role="alertdialog" aria-label="Confirm disconnect">
        <p>{copy.confirm}</p>
        {copy.google && <p><a href={GOOGLE_PERMISSIONS} target="_blank" rel="noopener noreferrer">Google&rsquo;s permissions page</a></p>}
        <div className="mcp-actions">
          <button type="button" disabled={busy} onClick={() => void run(async () => {
            await port.revoke(server.id, confirming.account.id);
            setConfirming(null);
          }, copy.google
            ? "tm8 stops using this connection. To remove tm8's access from your Google account entirely, use Google's permissions page."
            : 'Connection disconnected.')}>Confirm disconnect</button>
          <button type="button" onClick={() => setConfirming(null)}>Cancel</button>
        </div>
      </div>;
    })()}

    {confirming?.kind === 'gate' && <div className="mcp-confirm" role="alertdialog" aria-label="Confirm tool change">
      <p>This changes what {server.title} can do. {live.length} connection{live.length === 1 ? '' : 's'} will need to reconnect.</p>
      <div className="mcp-actions">
        <button type="button" disabled={busy} onClick={() => {
          const gate = confirming.gate, open = confirming.open;
          setConfirming(null);
          void patchDefinition({ gates: { ...gates, [gate]: open } }, open ? 'Tool enabled.' : 'Tool disabled.');
        }}>Confirm change</button>
        <button type="button" onClick={() => setConfirming(null)}>Cancel</button>
      </div>
    </div>}

    {confirming?.kind === 'disable' && <div className="mcp-confirm" role="alertdialog" aria-label="Confirm connector state">
      <p>{server.enabled
        ? `Disable ${server.title}? Chats and sessions stop loading its tools immediately.`
        : `Enable ${server.title}? Its tools become available again to everyone who has a connection.`}</p>
      <div className="mcp-actions">
        <button type="button" disabled={busy} onClick={() => { setConfirming(null); void patchDefinition({ enabled: !server.enabled }, server.enabled ? 'Connector disabled.' : 'Connector enabled.'); }}>Confirm</button>
        <button type="button" onClick={() => setConfirming(null)}>Cancel</button>
      </div>
    </div>}

    {confirming?.kind === 'config' && <div className="mcp-confirm" role="alertdialog" aria-label="Confirm sign-in change">
      <p>This changes how {server.title} signs in. {live.length} connection{live.length === 1 ? '' : 's'} will need to reconnect.</p>
      <div className="mcp-actions">
        <button type="button" disabled={busy} onClick={() => {
          const input = confirming.input;
          setConfirming(null);
          void run(async () => { await port.patch(server, definitionPatch(input)); setEditing(false); }, 'Connector saved.');
        }}>Confirm change</button>
        <button type="button" onClick={() => setConfirming(null)}>Cancel</button>
      </div>
    </div>}

    {confirming?.kind === 'delete' && <div className="mcp-confirm mcp-confirm--danger" role="alertdialog" aria-label="Confirm delete">
      <p>Delete {server.title}? {live.length} connection{live.length === 1 ? '' : 's'} will be revoked.</p>
      <label>Type the connector&rsquo;s name to confirm<input value={typed} onChange={e => setTyped(e.target.value)} autoComplete="off" /></label>
      <div className="mcp-actions">
        <button type="button" disabled={busy || typed !== server.title} onClick={() => void run(async () => {
          await port.remove(server);
          setConfirming(null);
          onClose();
        }, 'Connector deleted.')}>Delete connector</button>
        <button type="button" onClick={() => setConfirming(null)}>Cancel</button>
      </div>
    </div>}
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
