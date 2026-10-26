import { ConnectorToggleList } from './ConnectorToggleList';
import { useLayoutEffect, useId, type ReactNode } from 'react';
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
/**
 * The problem with an EXPLICIT selection, and only an explicit one (G15).
 *
 * It used to check `value ?? catalog.defaults`, so a Space default with no
 * connected account blocked a launch nobody had configured. §7.3 settled that
 * the other way: the server resolves defaults itself and reports one it cannot
 * open as `skipped: not connected` instead of failing the launch, and the UI
 * shows it as "needs connect". An untouched picker therefore has no problem to
 * report, because it is not asserting anything.
 *
 * An explicit pick is still held to the old standard. Naming a connector and
 * giving it no usable account is a request that cannot be honoured, and `bind`
 * refuses it out loud (B9) — so refusing it here, where the account can still
 * be chosen, is the better place to say so.
 */
export function selectionProblem(catalog: McpCatalog, value: McpSelection[] | undefined): string | null {
  for (const selected of value ?? []) {
    const problem = readiness(catalog.servers.find(s => s.id === selected.serverId), selected);
    if (problem) return problem;
  }
  return null;
}

/**
 * Undefined inherits defaults, [] deliberately disables all optional connectors.
 * Renders nothing unless there is a connector to choose or a problem to fix, and only
 * blocks the launch for a selection that cannot work; loading, refreshing and an
 * unreadable catalog never block it, because the server resolves defaults itself.
 *
 * G15: IT NO LONGER SENDS A TRIMMED DEFAULT LIST. It used to notice that some
 * default had no connected account and call `onChange(usableDefaults(catalog))`
 * from a layout effect — which turned "the user chose nothing" into an explicit
 * selection, computed from whatever the browser could see. §5.3's rule is the
 * opposite: the field is sent ONLY when the user changed something, so defaults
 * resolve server-side at launch, under the provenance root's own claims, with
 * §3's account order and a `skipped: not connected` report for the ones it
 * cannot open. The browser's view of "usable" was never the authority, and
 * sending it meant a connector connected between the page load and the launch
 * was silently left off.
 */
export function McpPicker({ targetId, teamMemberId, value, onChange, onReady, disabled = false, headless = false, retryClassName,
  layout = 'list', notice, resetLabel }: {
  targetId?: string; teamMemberId?: string; value: McpSelection[] | undefined;
  onChange(value: McpSelection[] | undefined): void; onReady?(ready: boolean): void; disabled?: boolean;
  /** Keep the readiness reporting, draw nothing (the picker is drawn elsewhere, e.g. in ＋). */
  headless?: boolean;
  retryClassName?: string;
  /** §10.5 draws the launch grid in two columns. */
  layout?: 'list' | 'grid';
  /** §10.5's harness ⓘ line, passed through to the shared list. */
  notice?: ReactNode;
  resetLabel?: string;
}) {
  const { catalog, error, port, refresh } = useMcpCatalog(targetId, teamMemberId);
  const id = useId();
  const problem = catalog ? selectionProblem(catalog, value) : null;
  useLayoutEffect(() => { onReady?.(!port || !!error || (!!catalog && !problem)); }, [port, catalog, error, problem, onReady]);
  if (!port || headless) return null;
  if (!catalog) return error ? <p className="mcp-error" role="alert">{error} <button type="button" className={retryClassName} onClick={refresh}>Retry connectors</button></p> : null;
  if (!catalog.canAttach) return null;
  const attachable = catalog.servers.filter(server => server.canAttach);
  if (attachable.length === 0 && !problem) return null;
  // §10.5: COLLAPSED BY DEFAULT to one summary line, which is also what keeps
  // the launch card's layout from being decided by how many connectors a Space
  // happens to hold. The summary names the connectors that are on and says
  // whose decision that is, so the card tells the truth while shut.
  const selected = value ?? catalog.defaults;
  const names = attachable.filter(server => selected.some(s => s.serverId === server.id)).map(server => server.title);
  const summary = `Connectors: ${names.length > 0 ? names.join(', ') : 'none'}${value === undefined ? ' (Space defaults)' : ''}`;
  return <fieldset className="mcp-picker" disabled={disabled} aria-describedby={`${id}-help`}>
    <legend>Connectors</legend>
    <details>
      <summary data-testid="mcp-picker-summary">{summary}</summary>
      <p id={`${id}-help`}>Choose the connectors and account for this session.</p>
      <ConnectorToggleList
        catalog={catalog}
        value={value}
        onChange={onChange}
        disabled={disabled}
        layout={layout}
        testId="mcp-picker-toggles"
        {...(resetLabel ? { resetLabel } : {})}
        {...(notice ? { notice } : {})}
        {...(problem ? { problem } : {})}
      />
    </details>
  </fieldset>;
}
