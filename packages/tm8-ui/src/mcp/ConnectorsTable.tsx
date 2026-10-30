/**
 * SETTINGS → CONNECTORS (§10.1 personal view, §10.3 Space-admin view, D1).
 *
 * This replaces the card list `McpSettings.tsx` used to render. The old screen
 * was a stack of `<article>` cards, one per connector, each repeating the
 * connector's URL and approval state and hiding the account work two clicks
 * deep behind "Manage <name>" — so the one question the page exists to answer,
 * *which of my connectors are actually working*, took N clicks to read.
 *
 * WHAT THE SHAPE IS, AND WHY IT IS THREE TABS ON ONE PAGE.
 *
 *  - **Yours** — every connector in this Space, with the §10.0 status. This is
 *    the page as a table: Connector / Type / Access / Status, one row each,
 *    the thing D1 asked for.
 *  - **Discover** — the catalog, from `mcp.catalog.list` (B16), NOT from the
 *    old `ui/mcp/directory.ts`. That file held the same three presets as
 *    UI-only data, so the CLI could not offer them and no server could tell
 *    which preset a connector came from. Each card's button comes from the
 *    entry's `available` and `added` (S7).
 *  - **Space admin** — §10.3. It is a TAB rather than a route because the one
 *    settings nav has a single `connectors` section id and the section
 *    contract forbids this lane editing the shell, the nav or the section
 *    types (S19 accepted this). A non-admin never sees the tab, and that is
 *    presentation only: every write it offers is checked by the server.
 *
 * ONE RULE WORTH STATING. A catalog load error NEVER blocks anything here, and
 * nothing on this page is the gate for a send or a launch — the server resolves
 * defaults itself (today's `McpPicker` rule, kept).
 */
import { useEffect, useMemo, useState } from 'react';
import type { McpCatalogEntry } from '@tm8/contract';
import { SectionFrame } from '../settings-space';
import { ConnectorLogo, serverLogo } from './connector-logos';
import { ConnectorDrawer } from './ConnectorDrawer';
import { ConnectorForm } from './ConnectorForm';
import { ImportMcpJson } from './ImportMcpJson';
import { accessLabel, limitedAccessCount, matchesFilter, matchesSearch, rowStatusOf, statusLabel, typeLabel, FILTERING, NO_FILTER, STATUS_ROWS, type ConnectorFilter } from './connector-rows';
import { useMcpCatalog } from './context';
import { takeConnectedToast } from './oauth-callback';
import { McpUiError } from './errors';
import { connectorAdmin } from './ConnectorEntityBlock';
import { useConnectorRun } from './useConnectorRun';
import type { McpImportRow } from './adapter';
import type { McpCatalog, McpPort, McpServer } from './port';
import './mcp.css';
import './connectors.css';

type Tab = 'yours' | 'discover' | 'admin';
type Sheet = null | { kind: 'custom' } | { kind: 'import' };

/** A `details` popover stays open after its choice unless the choice closes it. */
const close = (event: { currentTarget: HTMLElement }) => event.currentTarget.closest('details')?.removeAttribute('open');

/** `?connector=<id>` on the connectors route opens that row's drawer (§10.1 deep link). */
function deepLinkedConnector(hash = window.location.hash): string | null {
  const query = hash.indexOf('?');
  if (query < 0) return null;
  const id = new URLSearchParams(hash.slice(query + 1)).get('connector');
  return id && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

function SkeletonRows() {
  return <>{[0, 1, 2, 3, 4].map(n => <tr key={n} className="mcp-row--skeleton" aria-hidden="true">
    <td><span /></td><td><span /></td><td><span /></td><td><span /></td>
  </tr>)}</>;
}

function StatusCell({ server, admin, busy, onConnect, onApprove, onTest }: {
  server: McpServer; admin: boolean; busy: boolean;
  onConnect(): void; onApprove(): void; onTest(): void;
}) {
  const row = rowStatusOf(server);
  const spec = STATUS_ROWS[row.status];
  const label = statusLabel(row.status, { name: server.title, statusReason: row.statusReason ?? null });
  const act = spec.action && (!spec.adminOnly || admin) ? spec.action : null;
  // S10: a partial grant stays `ready` — the connection works for what it
  // covers — so the gap is a badge beside the tick, not a different status.
  const limited = limitedAccessCount(row);
  return <span className="mcp-status">
    <span className={`mcp-state mcp-state--${spec.tone}`} title={label}>
      <span aria-hidden="true">{spec.icon}</span>
      <span className="mcp-status__text">{label}</span>
    </span>
    {/* `ready` shows the provider's own account name where there is one — that
        is the whole of §10.0's "account label on hover", made visible. */}
    {row.status === 'ready' && row.account && <span className="mcp-note" title={row.account.accountLabel ?? row.account.label}>{row.account.accountLabel ?? row.account.label}</span>}
    {limited > 0 && <span className="mcp-badge mcp-badge--warn" title={`${limited} tool${limited === 1 ? '' : 's'} need more access. Open the connector to reconnect.`}>Limited access</span>}
    {act === 'connect' && <button type="button" disabled={busy} onClick={onConnect}>Connect</button>}
    {act === 'reconnect' && <button type="button" disabled={busy} onClick={onConnect}>Reconnect</button>}
    {act === 'approve' && <button type="button" disabled={busy} onClick={onApprove}>Approve</button>}
    {act === 'test' && <button type="button" disabled={busy} onClick={onTest}>Test</button>}
  </span>;
}

/** S7: the Discover card's one button, decided by `available` and `added`. */
function DiscoverCard({ entry, admin, busy, onAdd, onRequest, onOpen }: {
  entry: McpCatalogEntry; admin: boolean; busy: boolean;
  onAdd(): void; onRequest(): void; onOpen(serverId: string): void;
}) {
  const added = entry.added ?? [];
  const approved = added.find(row => row.approved);
  const open = added.find(row => !row.approved);
  return <article className="mcp-card mcp-discover" key={entry.id}>
    <header><ConnectorLogo logo={entry.logo} title={entry.title} /><h3>{entry.title}</h3></header>
    <p>{entry.summary}</p>
    {!!entry.scopeLabels?.length && <ul className="mcp-scopes">{entry.scopeLabels.map(scope => <li key={scope}>{scope}</li>)}</ul>}
    {entry.requirement && <p className="mcp-note"><strong>Requires:</strong> {entry.requirement}</p>}
    <p><a href={entry.docsUrl} target="_blank" rel="noopener noreferrer">{entry.title} MCP documentation</a></p>
    {!entry.available
      // B15: announced but not usable. A card whose Connect always fails is
      // worse than no card, so the button is off for everyone, admin included.
      ? <button type="button" disabled aria-disabled="true" title="This connector isn't available in tm8 yet.">Coming soon</button>
      : approved
        ? <button type="button" onClick={() => onOpen(approved.serverId)}>Added</button>
        : open
          // B22/B25: a member already asked for this entry. An admin APPROVES
          // that row; creating a second connector would orphan it.
          ? admin
            ? <button type="button" disabled={busy} onClick={onAdd}>Approve request</button>
            : <button type="button" disabled aria-disabled="true" title="An administrator has been asked to add this connector.">Requested</button>
          : admin
            ? <button type="button" disabled={busy} onClick={onAdd}>Add to Space</button>
            : <button type="button" disabled={busy} onClick={onRequest}>Request</button>}
  </article>;
}

/** §10.3's Policy card. Both controls are honestly off: neither verb exists on this node yet. */
function PolicyCard() {
  return <section className="mcp-card">
    <h3>Policy</h3>
    <label className="mcp-toggle"><span>
      <input type="checkbox" disabled aria-disabled="true" />
      Allow members&rsquo; personal connections in sessions spawned into this Space from other Spaces
    </span></label>
    <p className="mcp-note">Not available yet.</p>
    <button type="button" disabled aria-disabled="true">Revoke all connections in this Space</button>
    <p className="mcp-note">Coming with connection hardening.</p>
  </section>;
}

export function ConnectorsTable({ catalog, port, admin, busy, run, refresh, loading, error, tab, setTab, sheet, setSheet }: {
  catalog?: McpCatalog; port: McpPort; admin: boolean; busy: boolean;
  run(action: () => Promise<unknown>, success: string): Promise<void>;
  refresh(): void; loading: boolean; error?: string;
  /** Held by the section so the head's "+ Add" menu can switch tabs and open a sheet. */
  tab: Tab; setTab(tab: Tab): void; sheet: Sheet; setSheet(sheet: Sheet): void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ConnectorFilter>(NO_FILTER);
  const [active, setActive] = useState<string | null>(() => deepLinkedConnector());
  const [entries, setEntries] = useState<McpCatalogEntry[] | null>(null);
  const [entriesError, setEntriesError] = useState(false);

  // A deep link to the admin tab is not a way in: a non-admin lands on Yours
  // (§10.3's redirect), and the server would refuse the writes anyway.
  useEffect(() => { if (!admin && tab === 'admin') setTab('yours'); }, [admin, tab]);

  /** Discover loads the catalog once the tab is opened, so the common page load stays one read. */
  useEffect(() => {
    if (tab !== 'discover' && tab !== 'admin') return;
    // `busy` is the trigger, not a condition: a write that changes `added`
    // re-runs this when it SETTLES. Reading mid-write would just race it.
    if (busy) return;
    let live = true;
    setEntriesError(false);
    void port.catalogEntries().then(
      items => { if (live) setEntries(items); },
      () => { if (live) setEntriesError(true); },
    );
    return () => { live = false; };
  }, [port, tab, busy]);

  const servers = catalog?.servers ?? [];
  const visible = useMemo(() => servers
    .filter(server => matchesSearch(server, query))
    .filter(server => matchesFilter(server, rowStatusOf(server).status, filter)),
    [servers, query, filter]);
  const drawer = servers.find(server => server.id === active);

  function openConnect(server: McpServer) { setActive(server.id); }
  const approve = (server: McpServer) => run(() => port.patch(server, { approved: true }), `${server.title} approved.`);

  async function importRows(rows: McpImportRow[], trustLocal: boolean, defaultOn: boolean) {
    await run(async () => {
      // `defaultOn` joins every chat's and session's defaults in the Space;
      // each one can still turn the connector off for itself.
      await port.importMany(rows.flatMap(row => row.definition
        ? [{ ...row.definition, defaultOn, ...(row.transport === 'stdio' ? { stdioTrusted: trustLocal } : {}) }]
        : []));
      setSheet(null);
    }, `${rows.length} connector${rows.length === 1 ? '' : 's'} imported.`);
  }

  return <>
    <nav className="mcp-tabs" aria-label="Connector views">
      <button type="button" aria-pressed={tab === 'yours'} onClick={() => setTab('yours')}>Yours</button>
      <button type="button" aria-pressed={tab === 'discover'} onClick={() => setTab('discover')}>Discover</button>
      {admin && <button type="button" aria-pressed={tab === 'admin'} onClick={() => setTab('admin')}>Space admin</button>}
      <div className="mcp-tabs__grow" />
      {tab !== 'discover' && <>
        <label className="mcp-search"><span className="mcp-sr">Search connectors</span>
          <input type="search" value={query} placeholder="Search…" onChange={e => setQuery(e.target.value)} />
        </label>
        <details className="mcp-filter">
          <summary aria-label={FILTERING(filter) ? 'Filter connectors (active)' : 'Filter connectors'}>Filter{FILTERING(filter) ? ' ·' : ''}</summary>
          <div>
            <label>Status<select value={filter.status} onChange={e => setFilter({ ...filter, status: e.target.value as ConnectorFilter['status'] })}>
              <option value="all">Any</option><option value="connected">Connected</option><option value="attention">Needs attention</option><option value="unconnected">Not connected</option>
            </select></label>
            <label>Access<select value={filter.access} onChange={e => setFilter({ ...filter, access: e.target.value as ConnectorFilter['access'] })}>
              <option value="all">Any</option><option value="personal">Just me</option><option value="shared">Shared</option>
            </select></label>
            <label>Type<select value={filter.type} onChange={e => setFilter({ ...filter, type: e.target.value as ConnectorFilter['type'] })}>
              <option value="all">Any</option><option value="first_party">tm8-hosted</option><option value="remote">Remote</option><option value="local">Local</option>
            </select></label>
            {FILTERING(filter) && <button type="button" onClick={() => setFilter(NO_FILTER)}>Clear filter</button>}
          </div>
        </details>
      </>}
    </nav>

    {error && <p role="alert" className="mcp-error">Couldn&rsquo;t load connectors. <button type="button" onClick={refresh}>Retry</button></p>}

    {sheet?.kind === 'custom' && <section className="mcp-card mcp-sheet">
      <h3>{admin ? 'Add a custom connector' : 'Request a connector'}</h3>
      <ConnectorForm mode={admin ? 'manage' : 'request'} busy={busy} onCancel={() => setSheet(null)} onSave={(input, note) => run(async () => {
        // Since 405 any member registers, and the connector is live at once.
        // `approved: true` stays explicit for a node that predates it. Only a
        // viewer the server does not let register still goes to request.
        if (admin) await port.register({ ...input, approved: true }); else await port.request({ definition: input }, note);
        setSheet(null);
      }, admin ? `${input.title} added. Connect an account to start using it.` : 'Request sent to the administrators.')} />
    </section>}

    {sheet?.kind === 'import' && <section className="mcp-card">
      <h3>Import connectors</h3>
      <ImportMcpJson busy={busy} onImport={importRows}
        {...(admin && port.localConfigs ? { local: () => port.localConfigs!() } : {})}
        existing={servers.flatMap(server => server.source ? [{ id: server.id, definition: server.source }] : [])} />
      <button type="button" onClick={() => setSheet(null)}>Cancel</button>
    </section>}

    {tab === 'discover' && <>
      {entriesError && <p role="alert" className="mcp-error">Couldn&rsquo;t load the connector catalog. <button type="button" onClick={refresh}>Retry</button></p>}
      {!entries && !entriesError && <p role="status">Loading catalog…</p>}
      {entries && <div className="mcp-discover-grid">{entries.map(entry => <DiscoverCard key={entry.id} entry={entry} admin={admin} busy={busy}
        onOpen={serverId => { setActive(serverId); setTab('yours'); }}
        onAdd={() => void run(async () => {
          const outcome = await port.addFromCatalog(entry.id);
          setActive(outcome.serverId);
        }, `${entry.title} added to this Space.`)}
        onRequest={() => void run(() => port.request({ catalogId: entry.id }), `${entry.title} requested. The administrators have been asked.`)}
      />)}</div>}
    </>}

    {(tab === 'yours' || tab === 'admin') && <>

      <table className="mcp-table">
        <thead><tr>
          <th scope="col">Connector</th><th scope="col">Type</th>
          {tab === 'yours'
            ? <><th scope="col">Access</th><th scope="col">Status</th></>
            : <><th scope="col">Default on</th><th scope="col">Shared connection</th><th scope="col">External clients</th><th scope="col">Used by</th></>}
        </tr></thead>
        <tbody>
          {loading && !catalog && <SkeletonRows />}
          {catalog && visible.map(server => {
            const connections = server.accounts.filter(account => account.status !== 'revoked');
            return <tr key={server.id}>
              <td>
                {/* An explicit name: the mark is decorative and the `Custom`
                    pill is part of the cell, so the button's own accessible
                    name has to be the connector, not the cell's text. */}
                <button type="button" className="mcp-row__open" aria-label={`Open ${server.title}`} onClick={() => setActive(server.id)}>
                  <ConnectorLogo logo={serverLogo(server.source)} title={server.title} />
                  <span>{server.title}</span>
                  {!server.source?.catalogId && <span className="mcp-pill">Custom</span>}
                </button>
              </td>
              <td>{typeLabel(server)}</td>
              {tab === 'yours' ? <>
                <td>{accessLabel(server)}</td>
                <td><StatusCell server={server} admin={admin} busy={busy}
                  onConnect={() => openConnect(server)} onApprove={() => void approve(server)}
                  onTest={() => void run(async () => {
                    const result = await port.test({ serverId: server.id, ...(connections[0] ? { credentialId: connections[0].id } : {}) });
                    if (!result.ok) throw new McpUiError('This connector still did not answer. Open it to see the details.');
                  }, 'Connection tested.')} /></td>
              </> : <>
                {/* §10.3's inline toggles. Approval left this list with 405:
                    every connector a member adds is live, so the column only
                    ever read "yes". */}
                <td><label><span className="mcp-sr">On by default for everyone in this Space: {server.title}</span>
                  <input type="checkbox" checked={server.source?.defaultOn === true} disabled={busy || !server.canManage}
                    onChange={e => void run(() => port.patch(server, { defaultOn: e.target.checked }), 'Space default updated.')} />
                </label></td>
                <td>{server.accounts.some(a => a.scope === 'space' && a.status !== 'revoked') ? 'Yes' : '—'}</td>
                <td><label><span className="mcp-sr">Available to external MCP clients: {server.title}</span>
                  <input type="checkbox" checked={server.source?.allowExternalClients === true} disabled={busy || !server.canManage}
                    onChange={e => void run(() => port.patch(server, { allowExternalClients: e.target.checked }), 'External client access updated.')} />
                </label></td>
                <td>{connections.filter(a => a.scope !== 'space').length}</td>
              </>}
            </tr>;
          })}
        </tbody>
      </table>

      {catalog && servers.length === 0 && !loading && <div className="mcp-empty">
        {admin
          ? <><p>Connect Gmail, Figma, Calendar and more so your agents can use them.</p>
            <div className="mcp-actions">
              <button type="button" onClick={() => setTab('discover')}>Browse connectors</button>
              <button type="button" onClick={() => setSheet({ kind: 'custom' })}>Custom connector</button>
            </div></>
          : <><p>No connectors in this Space yet. Ask an admin, or request one.</p>
            <button type="button" onClick={() => setSheet({ kind: 'custom' })}>Request a connector</button></>}
      </div>}

      {catalog && servers.length > 0 && visible.length === 0 && <div className="mcp-empty">
        <p>No connectors match {query ? `“${query}”` : 'these filters'}.</p>
        <div className="mcp-actions">
          {query && <button type="button" onClick={() => setQuery('')}>Clear search</button>}
          {FILTERING(filter) && <button type="button" onClick={() => setFilter(NO_FILTER)}>Clear filter</button>}
          {tab === 'yours' && <button type="button" onClick={() => setTab('discover')}>Discover</button>}
        </div>
      </div>}

      {tab === 'admin' && <PolicyCard />}
      {tab === 'admin' && servers.some(server => server.transport === 'stdio') && <p className="mcp-note">
        Local connectors run on the tm8 host and can hold an API key only.
      </p>}
    </>}

    {tab !== 'discover' && <p className="mcp-note mcp-strict">
      Connectors you added in the Claude app or a <code>.mcp.json</code> file aren&rsquo;t used by tm8 chats or sessions, whatever the harness.
      Add them here. <button type="button" onClick={() => setSheet({ kind: 'import' })}>Import from Claude Code, Codex or .mcp.json</button>
    </p>}

    {drawer && <ConnectorDrawer server={drawer} port={port} admin={admin} busy={busy} run={run} onClose={() => setActive(null)} />}
  </>;
}

/**
 * The mounted section. The name stays `McpSettings` so the one place that
 * mounts it (`views/GateApp.tsx`) needs no edit, and the Space switcher at the
 * top of Settings keeps deciding which Space's connectors are listed (G16).
 */
export function ConnectorsSection() {
  const { catalog, port, error, loading, refresh } = useMcpCatalog();
  // §10.2's popup-blocked fallback finishes in a FULL PAGE NAVIGATION, so the
  // "connected as …" line cannot be handed over in React state. The callback
  // page parks the one authored sentence and this reads it once, on the way in.
  const [parked] = useState(() => takeConnectedToast());
  const { busy, run, message, failure, dismiss } = useConnectorRun(refresh, parked);
  const [tab, setTab] = useState<Tab>('yours');
  const [sheet, setSheet] = useState<Sheet>(null);

  if (!port) {
    return <SectionFrame title="Connectors" bodyTestId="connectors-body">
      <p role="status">Connectors are unavailable on this connection.</p>
    </SectionFrame>;
  }
  // S19: the list-level admin flag (`allowed.register` is `is_space_admin`),
  // widened by any single connector this viewer may approve or manage. Hiding
  // the tab is presentation; the server stays the boundary.
  const admin = connectorAdmin(catalog);
  return <SectionFrame title="Connectors" bodyTestId="connectors-body" measure={false}
    action={<details className="mcp-add"><summary className="set-chip">+ Add</summary>
      <div>
        <button type="button" onClick={e => { close(e); setSheet(null); setTab('discover'); }}>From catalog…</button>
        <button type="button" onClick={e => { close(e); setTab('yours'); setSheet({ kind: 'custom' }); }}>{admin ? 'Custom connector…' : 'Request a connector…'}</button>
        <button type="button" onClick={e => { close(e); setTab('yours'); setSheet({ kind: 'import' }); }}>Import from Claude Code / Codex…</button>
      </div>
    </details>}>
    <section className="mcp-settings" aria-label="Connector management" aria-busy={busy}>
      <p>Connect tools so your chats and sessions can use them.</p>
      {failure && <p role="alert" className="mcp-flash mcp-flash--error">{failure} <button type="button" className="mcp-link" onClick={dismiss}>Dismiss</button></p>}
      {message && <p role="status" className="mcp-flash">{message}</p>}
      <ConnectorsTable catalog={catalog} port={port} admin={admin} busy={busy} run={run} refresh={refresh}
        loading={loading} tab={tab} setTab={setTab} sheet={sheet} setSheet={setSheet} {...(error ? { error } : {})} />
    </section>
  </SectionFrame>;
}
