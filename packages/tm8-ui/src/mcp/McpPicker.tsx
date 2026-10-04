import { ConnectorsLink } from './ConnectorsLink';
import { useLayoutEffect, useId } from 'react';
import { useMcpCatalog } from './context';
import type { McpCatalog, McpSelection, McpServer } from './port';
import './mcp.css';

export function readiness(server: McpServer | undefined, selection: McpSelection): string | null {
  if (!server) return 'This connector is no longer available.';
  if (!server.canAttach) return server.unavailableReason ?? 'You cannot attach this connector.';
  if (!server.approved || !server.enabled) return 'This connector is awaiting approval or disabled.';
  if (server.auth !== 'none' && !server.accounts.some(a => a.id === selection.credentialId && a.canUse && a.status === 'connected')) {
    return 'Choose a connected account.';
  }
  return null;
}
export function selectionProblem(catalog: McpCatalog, value: McpSelection[] | undefined): string | null {
  for (const selected of value ?? catalog.defaults) {
    const problem = readiness(catalog.servers.find(s => s.id === selected.serverId), selected);
    if (problem) return problem;
  }
  return null;
}

/** Undefined inherits defaults, [] deliberately disables all optional connectors. */
export function McpPicker({ targetId, teamMemberId, value, onChange, onReady, disabled = false }: {
  targetId?: string; teamMemberId?: string; value: McpSelection[] | undefined;
  onChange(value: McpSelection[] | undefined): void; onReady?(ready: boolean): void; disabled?: boolean;
}) {
  const { catalog, error, loading, port, refresh } = useMcpCatalog(targetId, teamMemberId);
  const id = useId();
  const problem = catalog ? selectionProblem(catalog, value) : null;
  useLayoutEffect(() => { onReady?.(!port || (!!catalog && !loading && !problem)); }, [port, catalog, loading, problem, onReady]);
  if (!port) return null;
  if (error) return <p className="mcp-error" role="alert">{error} <button type="button" onClick={refresh}>Retry connectors</button></p>;
  if (loading) return <p role="status">Checking connectors…</p>;
  if (!catalog?.canAttach) return null;
  const selected = value ?? catalog.defaults;
  return <fieldset className="mcp-picker" disabled={disabled} aria-describedby={`${id}-help`}>
    <legend>Connectors</legend>
    <p id={`${id}-help`}>Choose the tools and account for this session.</p>
    <div className="mcp-actions">
      <button type="button" onClick={() => onChange(undefined)} aria-pressed={value === undefined}>Use defaults</button>
      <button type="button" onClick={() => onChange([])} aria-pressed={value?.length === 0}>None</button>
      <ConnectorsLink>Manage connectors</ConnectorsLink>
    </div>
    {catalog.servers.length === 0 && <p>No connectors have been registered.</p>}
    {catalog.servers.filter(server => server.canAttach).map(server => {
      const pick = selected.find(s => s.serverId === server.id);
      const accounts = server.accounts.filter(a => a.canUse && a.status === 'connected');
      const unavailable = !server.approved || !server.enabled || (server.auth !== 'none' && accounts.length === 0);
      return <div className="mcp-row" key={server.id}>
        <label><input type="checkbox" checked={!!pick} disabled={unavailable && !pick}
          onChange={e => onChange(e.target.checked ? [...selected, { serverId: server.id }] : selected.filter(s => s.serverId !== server.id))} />
          <span><strong>{server.title}</strong><small>{server.description}</small></span>
        </label>
        {pick && server.auth !== 'none' && <label className="mcp-account">Account for {server.title}
          <select value={pick.credentialId ?? ''} onChange={e => onChange(selected.map(s => s.serverId === server.id ? { serverId: server.id, ...(e.target.value ? { credentialId: e.target.value } : {}) } : s))}>
            <option value="">Choose an account</option>
            {accounts.map(a => <option value={a.id} key={a.id}>{a.label}</option>)}
          </select>
        </label>}
        <small>{!server.approved ? 'Awaiting approval' : !server.enabled ? 'Disabled' : server.auth === 'none' ? 'No account needed' : accounts.length ? 'Connected' : 'Not connected'}</small>
        {server.auth !== 'none' && accounts.length === 0 && <ConnectorsLink>Connect {server.title}</ConnectorsLink>}
      </div>;
    })}
    {problem && <p role="alert" className="mcp-error">{problem}</p>}
  </fieldset>;
}
