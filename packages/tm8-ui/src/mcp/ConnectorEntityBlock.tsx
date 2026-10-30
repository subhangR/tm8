/**
 * THE `mcp_server` ENTITY PAGE — the connector itself, not a door to Settings.
 *
 * Opening a connector as an entity tab used to draw one full-width "Manage
 * connectors and accounts →" button and nothing else. A person who opened it
 * wanted to know what it is, whether it works, what tools it has and who uses
 * it; this draws all of that, from the same catalog read and the same
 * `ConnectorDetail` body the Connectors page's drawer uses, so the two never
 * disagree.
 *
 * Two sections are this page's own, because they read the ENTITY rather than
 * the catalog row: Used by (the `equips` edges that point at this connector)
 * and Recent calls (`mcp.audit.list`, scoped by the server to what the caller
 * may read).
 */
import { useEffect, useState } from 'react';
import type { EntityDetail, McpCallAuditRow } from '@tm8/contract';
import { KindIcon } from '../domain';
import { navStore } from '../stores/navStore';
import { ConnectorDetail, Section, ago } from './ConnectorDrawer';
import { useMcpCatalog } from './context';
import type { McpCatalog, McpPort, McpServer } from './port';
import { useConnectorRun } from './useConnectorRun';
import './connectors.css';

/** S19: the list-level admin flag, widened by any connector this viewer may approve or manage. */
export function connectorAdmin(catalog: McpCatalog | undefined): boolean {
  return (catalog?.canRegister ?? false) || (catalog?.servers.some(server => server.canApprove || server.canManage) ?? false);
}

const OUTCOME: Record<McpCallAuditRow['outcome'], { label: string; tone: 'ok' | 'warn' | 'off' }> = {
  succeeded: { label: 'OK', tone: 'ok' }, failed: { label: 'Failed', tone: 'warn' }, denied: { label: 'Denied', tone: 'warn' },
  started: { label: 'Started', tone: 'off' }, refreshed: { label: 'Refreshed', tone: 'off' },
};
const VIA: Record<string, string> = { session: 'session', chat: 'chat', test: 'test', external_token: 'external client' };

function RecentCalls({ port, server }: { port: McpPort; server: McpServer }) {
  const [rows, setRows] = useState<McpCallAuditRow[] | null>(null);
  const [scope, setScope] = useState<'space' | 'own'>('own');
  const [failed, setFailed] = useState(false);
  const audit = port.audit;
  useEffect(() => {
    if (!audit) return;
    let live = true;
    void audit.call(port, server.id, 15).then(
      result => { if (live) { setRows(result.items); setScope(result.scope); } },
      () => { if (live) setFailed(true); },
    );
    return () => { live = false; };
  }, [audit, port, server.id, server.version]);
  if (!audit) return null;
  return <Section title="Recent calls" {...(rows?.length ? { count: rows.length } : {})}>
    {failed && <p className="mcp-note">Call history could not be loaded.</p>}
    {!failed && !rows && <p className="mcp-note">Loading…</p>}
    {rows && rows.length === 0 && <p className="mcp-note">{scope === 'own' ? 'You have made no calls to this connector yet.' : 'No calls to this connector yet.'}</p>}
    {rows && rows.length > 0 && <>
      <table className="mcp-params mcp-calls">
        <thead><tr><th scope="col">Tool</th><th scope="col">Outcome</th><th scope="col">Via</th><th scope="col">When</th></tr></thead>
        <tbody>{rows.map(row => {
          const outcome = OUTCOME[row.outcome];
          return <tr key={row.id}>
            <td><code>{row.tool ?? row.method}</code></td>
            <td><span className={`mcp-state mcp-state--sm mcp-state--${outcome.tone}`}>{outcome.label}</span>{row.denyReason && <span className="mcp-note"> {row.denyReason.replace(/_/g, ' ')}</span>}</td>
            <td>{row.via ? VIA[row.via] ?? row.via : '—'}{row.latencyMs != null && <span className="mcp-note"> · {row.latencyMs} ms</span>}</td>
            <td title={new Date(row.occurredAt).toLocaleString()}>{ago(row.occurredAt)}</td>
          </tr>;
        })}</tbody>
      </table>
      {scope === 'own' && <p className="mcp-note">Showing your own calls. A Space admin sees everyone&rsquo;s.</p>}
    </>}
  </Section>;
}

function UsedBy({ detail, server, onOpenEntity }: { detail: EntityDetail; server: McpServer; onOpenEntity?(id: string): void }) {
  const equips = detail.connections.incoming.filter(group => group.type === 'equips').flatMap(group => group.edges);
  return <Section title="Used by" {...(equips.length ? { count: equips.length } : {})}>
    <p className="mcp-note">{server.source?.defaultOn
      ? 'On by default for every chat and session in this Space.'
      : 'Not on by default: a chat or session uses it only when it is switched on there or equipped below.'}</p>
    {equips.length > 0 && <ul className="mcp-used">
      {equips.map(edge => <li key={edge.id}>
        <button type="button" className="mcp-used__item" onClick={() => onOpenEntity?.(edge.source.id)} disabled={!onOpenEntity}>
          <KindIcon kind={edge.source.kind} size={13} />
          <span>{edge.source.title}</span>
          <span className="mcp-note">{edge.source.kind.replace(/_/g, ' ')}</span>
        </button>
      </li>)}
    </ul>}
  </Section>;
}

function ManageLink() {
  return <button type="button" className="mcp-link" data-testid="settings-home-link"
    onClick={() => navStore.getState().navigate({ view: 'settings', section: 'connectors' })}>Manage connectors →</button>;
}

export function ConnectorEntityBlock({ detail, onOpenEntity }: { detail: EntityDetail; onOpenEntity?(id: string): void }) {
  const { catalog, port, loading, error, refresh } = useMcpCatalog();
  const { busy, run, message, failure, dismiss } = useConnectorRun(refresh);
  const server = catalog?.servers.find(row => row.id === detail.id);

  if (!port) return <div className="mcp-entity"><p className="mcp-note">Connector details are unavailable on this connection.</p><ManageLink /></div>;
  if (!server) {
    return <div className="mcp-entity">
      <p className="mcp-note" role="status">{loading || !catalog ? 'Loading connector…' : error ? 'Couldn’t load this connector.' : 'This connector is not visible to you in this Space.'}</p>
      {error && <button type="button" onClick={refresh}>Retry</button>}
      <ManageLink />
    </div>;
  }
  const admin = connectorAdmin(catalog);
  return <div className="mcp-entity" aria-busy={busy}>
    <div className="mcp-entity__bar"><ManageLink /></div>
    {failure && <p role="alert" className="mcp-flash mcp-flash--error">{failure} <button type="button" className="mcp-link" onClick={dismiss}>Dismiss</button></p>}
    {message && <p role="status" className="mcp-flash">{message}</p>}
    <ConnectorDetail server={server} port={port} admin={admin} busy={busy} run={run}
      onDeleted={() => navStore.getState().navigate({ view: 'settings', section: 'connectors' })}
      provenance={{ createdBy: detail.createdBy?.displayName ?? null, createdAt: detail.createdAt }}
      extra={<>
        <UsedBy detail={detail} server={server} {...(onOpenEntity ? { onOpenEntity } : {})} />
        <RecentCalls port={port} server={server} />
      </>} />
  </div>;
}
