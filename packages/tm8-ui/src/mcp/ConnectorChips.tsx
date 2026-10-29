/**
 * §10.5 IN ONE LINE — the launch card's connectors, as a row of chips.
 *
 * The compact sibling of `ConnectorToggleList`, with the same contract: it is
 * handed the catalog and the selection (`undefined` = the Space's defaults,
 * `[]` = none, a list = exactly these), draws them, and reports a change
 * through `onChange` ONLY when the person switches, pins or resets something.
 * It emits nothing of its own accord, for the reason the toggle list gives: a
 * picker that rewrites "nothing chosen" into a list turns the browser's view
 * into the launch's authority (S22). Drawn by `McpPicker` for
 * `layout="compact"`, which owns the read, the gate and the count.
 *
 * One chip per connector the viewer can act on: logo, name, and the account a
 * launch would open (the pin, else the server's own-then-shared choice, from
 * the row model). Pressed means on in the EFFECTIVE set, a default included.
 * A connector waiting on an admin is left off the row unless it is on — but
 * nothing is lost: the full list, every option the launch grid had and under
 * the grid's own test ids, opens under the row from its last control. Compact
 * demotes an option; it never removes one.
 */
import { useId, useState, type ReactNode } from 'react';
import { AccountSelect, wantsAccountChoice } from './AccountSelect';
import { ConnectorLogo, serverLogo } from './connector-logos';
import { ConnectorsLink } from './ConnectorsLink';
import { ConnectorToggleList } from './ConnectorToggleList';
import { connectorRows, pinned, toggled, type ConnectorRow } from './row-model';
import type { McpCatalog, McpSelection } from './port';
import './mcp.css';

export interface ConnectorChipsProps {
  catalog: McpCatalog;
  /** undefined = the human has chosen nothing; the Space's defaults apply. */
  value: McpSelection[] | undefined;
  onChange(next: McpSelection[] | undefined): void;
  /** Keep the chips, refuse the change (a launch in flight). */
  disabled?: boolean;
  /** The selection gate's sentence (`selectionGate`), drawn under the row. */
  problem?: string | null;
  /** The catalog's last read failed while these chips are still shown: one line, with its retry. */
  readError?: ReactNode;
  /** §10.5's harness note, drawn in the full list. */
  notice?: ReactNode;
  resetLabel?: string;
}

export function ConnectorChips({ catalog, value, onChange, disabled = false, problem, readError, notice, resetLabel }: ConnectorChipsProps) {
  // The full list's one state: shut (the row alone) or open (the list on its own line under it).
  const [full, setFull] = useState(false);
  const listId = useId();
  const selected = value ?? catalog.defaults;
  // Computed every render, like the toggle list's rows: a revocation mutates
  // the catalog in place, and a memo would serve the old account.
  const rows = connectorRows(catalog, selected, value !== undefined);
  const chips = rows.filter(row => row.on || row.actionable);
  const hidden = rows.length - chips.length;
  return <div className="mcp-compact" role="group" aria-label="Connectors" data-testid="mcp-compact"
    data-using={value === undefined ? 'defaults' : 'custom'}>
    <ul className="mcp-compact__chips">
      {chips.map(row => <Chip key={row.server.id} row={row} disabled={disabled}
        onToggle={on => onChange(toggled(selected, row.server.id, on))}
        onPin={credentialId => onChange(pinned(selected, row.server.id, credentialId))} />)}
    </ul>
    {/* Back to undefined — "the Space decides" — which is a different value
        from today's defaults written out as a list (S23). Not while the full
        list is open: it carries its own Reset, and one action gets one button. */}
    {value !== undefined && !full ? <button type="button" className="mcp-compact__reset" data-testid="mcp-compact-reset" disabled={disabled}
      title="Back to the Space’s default connectors" onClick={() => onChange(undefined)}>{resetLabel ?? 'Reset'}</button> : null}
    {rows.length > 0 ? (
      <button type="button" className="mcp-compact__more" data-testid="mcp-picker-summary" aria-expanded={full}
        aria-controls={listId} aria-label="All connectors and options"
        title={hidden > 0 ? `${hidden} more waiting on an admin, and every option` : 'Every connector option'}
        onClick={() => setFull(open => !open)}>
        {hidden > 0 ? `+${hidden} more` : '⋯'}
      </button>
    ) : null}
    {problem ? <p className="mcp-error mcp-compact__line" role="alert">{problem}</p> : null}
    {readError}
    {full ? (
      <div id={listId} className="mcp-compact__full">
        <ConnectorToggleList
          catalog={catalog}
          value={value}
          onChange={onChange}
          disabled={disabled}
          layout="grid"
          testId="mcp-picker-toggles"
          {...(resetLabel ? { resetLabel } : {})}
          {...(notice ? { notice } : {})}
        />
      </div>
    ) : null}
  </div>;
}

/**
 * One connector. A chip that cannot be switched on is the way to fix it
 * instead: its remedies (Connect, Reconnect) live on the Connectors page, so it
 * is a link there rather than a disabled button that explains nothing.
 */
function Chip({ row, disabled, onToggle, onPin }: {
  row: ConnectorRow; disabled: boolean; onToggle(on: boolean): void; onPin(credentialId: string): void;
}) {
  const { server } = row;
  const state = row.status !== 'ready' ? row.short : server.auth === 'none' ? null : row.account?.label ?? 'Choose account';
  const body = <>
    <ConnectorLogo logo={serverLogo(server.source)} title={server.title} />
    <span className="mcp-chip__name">{server.title}</span>
    {state ? <span className="mcp-chip__state">{state}</span> : null}
  </>;
  // Skipped (a default) or refused (a pick) until fixed — said on the chip,
  // because the row is the only place the launch card says it at all.
  const title = row.on && row.status !== 'ready' && row.status !== 'server_unavailable'
    ? `${row.text}. On, but it will not reach this session until this is fixed.`
    : row.text;
  // The chip draws the account control only when there is a CHOICE to make —
  // several accounts, one only a pin opens, or a dead pin to replace. One own
  // or shared account is named on the chip instead; the full list still
  // offers the control for it.
  const choose = wantsAccountChoice(row) && (row.deadPin || row.accounts.length > 1 || !row.account);
  return <li className="mcp-chip" data-status={row.status} data-on={row.on || undefined} data-testid={`mcp-chip-${server.id}`}>
    {row.toggle
      ? <button type="button" className="mcp-chip__toggle" aria-pressed={row.on} disabled={disabled} title={title}
          data-testid={`mcp-chip-toggle-${server.id}`} onClick={() => onToggle(!row.on)}>{body}</button>
      : <ConnectorsLink label={`${row.action === 'reconnect' ? 'Reconnect' : 'Connect'} ${server.title}`} title={row.text}>{body}</ConnectorsLink>}
    {choose ? <AccountSelect row={row} disabled={disabled} testId={`mcp-chip-account-${server.id}`} className="mcp-chip__account" onPin={onPin} /> : null}
  </li>;
}
