import { ConnectorsLink } from './ConnectorsLink';
import { useLayoutEffect, useId, useRef } from 'react';
import { useMcpCatalog } from './context';
import { droppedDefault } from './errors';
import type { McpCatalog, McpSelection, McpServer } from './port';
import './mcp.css';

/** One readiness reason, in the server's vocabulary, so one authored map explains both. */
export function clientReason(server: McpServer | undefined, selection: McpSelection): string | null {
  if (!server) return 'server_unavailable';
  // Approval and enablement are checked FIRST: the catalog derives canAttach
  // from them, so testing attachment first reported "you cannot use the
  // account" for every connector that was merely awaiting approval.
  if (!server.approved) return 'not_approved';
  if (!server.enabled) return 'disabled';
  if (!server.canAttach) return 'access_denied';
  if (server.auth !== 'none' && !server.accounts.some(a => a.id === selection.credentialId && a.canUse && a.status === 'connected')) {
    return 'credential_required';
  }
  return null;
}
export function readiness(server: McpServer | undefined, selection: McpSelection): string | null {
  switch (clientReason(server, selection)) {
    case null: return null;
    case 'server_unavailable': return 'This connector is no longer available.';
    case 'access_denied': return server?.unavailableReason ?? 'You cannot attach this connector.';
    case 'not_approved': case 'disabled': return 'This connector is awaiting approval or disabled.';
    default: return 'Choose a connected account.';
  }
}
export function selectionProblem(catalog: McpCatalog, value: McpSelection[] | undefined): string | null {
  for (const selected of value ?? catalog.defaults) {
    const problem = readiness(catalog.servers.find(s => s.id === selected.serverId), selected);
    if (problem) return problem;
  }
  return null;
}

/** Defaults the launch can actually use: a default with no connected account is left off rather than blocking the launch. */
export function usableDefaults(catalog: McpCatalog): McpSelection[] {
  return catalog.defaults.filter(selected => !readiness(catalog.servers.find(s => s.id === selected.serverId), selected));
}

/**
 * Defaults left out of the launch, named. The server drops them (it resolves
 * `equips` itself and reports each one with its reason); anything it still
 * hands over as a default that this client cannot use is added here, so a
 * connector is never dropped without a sentence saying which and why.
 */
export function droppedDefaults(catalog: McpCatalog): { serverId: string; title: string; reason: string }[] {
  const dropped = [...(catalog.droppedDefaults ?? [])];
  for (const selected of catalog.defaults) {
    const reason = clientReason(catalog.servers.find(s => s.id === selected.serverId), selected);
    if (!reason || dropped.some(d => d.serverId === selected.serverId)) continue;
    dropped.push({ serverId: selected.serverId, title: catalog.servers.find(s => s.id === selected.serverId)?.title ?? 'A connector', reason });
  }
  return dropped;
}

/**
 * Undefined inherits defaults, [] deliberately disables all optional connectors.
 * Renders nothing unless there is a connector to choose or a problem to fix, and only
 * blocks the launch for a selection that cannot work; loading, refreshing and an
 * unreadable catalog never block it, because the server resolves defaults itself.
 */
export function McpPicker({ targetId, teamMemberId, value, onChange, onReady, disabled = false }: {
  targetId?: string; teamMemberId?: string; value: McpSelection[] | undefined;
  onChange(value: McpSelection[] | undefined): void; onReady?(ready: boolean): void; disabled?: boolean;
}) {
  const { catalog, error, loading, port, refresh } = useMcpCatalog(targetId, teamMemberId);
  const id = useId();
  const trimmed = useRef<McpSelection[] | undefined>(undefined);
  const problem = catalog ? selectionProblem(catalog, value) : null;
  const unusableDefaults = value === undefined && !!catalog && !loading && !!problem;
  useLayoutEffect(() => {
    if (!unusableDefaults || !catalog) return;
    trimmed.current = usableDefaults(catalog);
    onChange(trimmed.current);
  }, [unusableDefaults, catalog, onChange]);
  useLayoutEffect(() => { onReady?.(!port || !!error || (!!catalog && !problem)); }, [port, catalog, error, problem, onReady]);
  if (!port) return null;
  if (!catalog) return error ? <p className="mcp-error" role="alert">{error} <button type="button" onClick={refresh}>Retry connectors</button></p> : null;
  if (!catalog.canAttach) return null;
  const attachable = catalog.servers.filter(server => server.canAttach);
  const selected = value ?? catalog.defaults;
  const usingDefaults = value === undefined || (value === trimmed.current);
  // A dropped default is often a connector that is no longer attachable at
  // all, so it appears in no row: the notice is the only place it shows, and
  // that makes it a reason to render the picker.
  const dropped = usingDefaults ? droppedDefaults(catalog) : [];
  if (attachable.length === 0 && !problem && dropped.length === 0) return null;
  return <fieldset className="mcp-picker" disabled={disabled} aria-describedby={`${id}-help`}>
    <legend>Connectors</legend>
    <p id={`${id}-help`}>Choose the tools and account for this session.</p>
    <div className="mcp-actions">
      <button type="button" onClick={() => onChange(undefined)} aria-pressed={usingDefaults}>Use defaults</button>
      <button type="button" onClick={() => onChange([])} aria-pressed={value?.length === 0 && !usingDefaults}>None</button>
      <ConnectorsLink>Manage connectors</ConnectorsLink>
    </div>
    {attachable.map(server => {
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
    {dropped.length > 0 && <p role="status" className="mcp-dropped">
      Not in this session: {dropped.map(d => `${d.title} (${droppedDefault(d.reason)})`).join('; ')}.
    </p>}
    {problem && <p role="alert" className="mcp-error">{problem}</p>}
  </fieldset>;
}
