/**
 * §10.0 — THE ONE TOGGLE LIST, drawn by three surfaces.
 *
 * The chat sheet (§10.4), the launch dialogs' Connectors section (§10.5, and
 * the full list behind the launch card's chips) and the debug view's read-only
 * mode all render THIS component. The readiness logic is `selection-gate.ts`'s;
 * `McpPicker` runs it and hands its body here, which is what the plan asks for
 * and what stops the three from drifting into three vocabularies for one state.
 *
 * ---------------------------------------------------------------------------
 * THE THREE-VALUE RULE, which is the whole reason this component is careful
 * ---------------------------------------------------------------------------
 *
 * `value === undefined` means THE HUMAN HAS CHOSEN NOTHING, and the caller
 * must then omit `mcpSelections` from its request so the server resolves
 * defaults itself at launch or at the next turn (§5.3, G15, S22). `[]` means
 * every connector off, which is a choice and is sent. A non-empty list
 * replaces the set.
 *
 * So this component never converts the first into the second. Toggling a row
 * starts from the EFFECTIVE set (`value ?? defaults`) and produces an explicit
 * list; `Reset` produces `undefined`; turning the last row off produces `[]`.
 * It emits no `onChange` of its own accord — no layout effect, no
 * normalisation pass — because the defect S22 closed was exactly that: a
 * picker that rewrote "nothing chosen" into a trimmed list computed from
 * whatever the browser could see, and so turned the browser's stale view of
 * which accounts are connected into the launch's authority.
 *
 * READ-ONLY MODE is not a disabled mode. `disabled` means "you may not change
 * this now" (a launch in flight, a save failing) and keeps the switches; the
 * debug view passes `readOnly`, which draws the same rows as text, because
 * there is nothing there to change — the launch already happened.
 */
import { useId, useState, type ReactNode } from 'react';
import { AccountSelect, wantsAccountChoice } from './AccountSelect';
import { ConnectorsLink } from './ConnectorsLink';
import { connectorRows, pinned, toggled, type ConnectorRow } from './row-model';
import type { McpCatalog, McpSelection } from './port';
import './mcp.css';

export interface ConnectorToggleListProps {
  catalog: McpCatalog;
  /** undefined = the human has chosen nothing; the Space's defaults apply. */
  value: McpSelection[] | undefined;
  onChange?(next: McpSelection[] | undefined): void;
  /** Keep the switches, refuse the change (a launch in flight, a save in flight). */
  disabled?: boolean;
  /** Draw the rows as a record. The debug view, where nothing is changeable. */
  readOnly?: boolean;
  /** A filter box above the rows. The chat sheet's, for a long roster. */
  filterable?: boolean;
  /** Two columns, as §10.5 draws the launch grid. */
  layout?: 'list' | 'grid';
  /** "Reset to Space defaults" (chat) or "Reset to defaults" (launch). */
  resetLabel?: string;
  contextualDefaults?: boolean;
  /** Drawn under the header: §10.5's harness ⓘ line, a save failure, a notice. */
  notice?: ReactNode;
  /** The explicit-selection problem `McpPicker` computed, shown at the foot. */
  problem?: string | null;
  testId?: string;
}

/**
 * The header's verdict, and the one fact a list cannot carry.
 *
 * S21/S23 made the ROW'S EXISTENCE the difference between "the Space decides
 * this thread's connectors" and "a human decided them", and the two can be the
 * same list. So this reads `value === undefined` and nothing else — never
 * "does the list equal the defaults", which would call a human's deliberate
 * pick of exactly the default set an inherited one and then quietly let a
 * later `defaultOn` flip change their mind for them.
 */
export function usingDefaults(value: McpSelection[] | undefined): boolean {
  return value === undefined;
}

export function ConnectorToggleList({
  catalog,
  value,
  onChange,
  disabled = false,
  readOnly = false,
  filterable = false,
  layout = 'list',
  resetLabel = 'Reset to defaults',
  contextualDefaults = false,
  notice,
  problem,
  testId = 'mcp-toggles',
}: ConnectorToggleListProps) {
  const id = useId();
  const [filter, setFilter] = useState('');
  const explicit = !usingDefaults(value);
  const selected = value ?? catalog.defaults;
  /*
   * COMPUTED EVERY RENDER, DELIBERATELY NOT MEMOIZED.
   *
   * A `useMemo` keyed on `[catalog, selected, explicit]` looks obviously right
   * and is wrong here: a revocation elsewhere in the provider mutates the
   * catalog IN PLACE and refreshes, so the object identity does not change and
   * the memo serves stale rows — a connector drawn as `ready` seconds after
   * its account was revoked. `mcp.test.tsx`'s "refreshes a mounted launch
   * picker immediately after revocation" is the cell that catches it. The work
   * is a map over at most 32 rows, which is not worth a correctness risk.
   */
  const rows = connectorRows(catalog, selected, explicit);
  const needle = filter.trim().toLowerCase();
  const shown = needle === ''
    ? rows
    : rows.filter(row => row.server.title.toLowerCase().includes(needle)
      || row.server.description.toLowerCase().includes(needle));

  const set = (next: McpSelection[]) => onChange?.(next);
  const toggle = (row: ConnectorRow, on: boolean) => set(toggled(selected, row.server.id, on));
  const pinAccount = (row: ConnectorRow, credentialId: string) => set(pinned(selected, row.server.id, credentialId));

  if (rows.length === 0) {
    return (
      <div className="mcp-toggles" data-testid={`${testId}-empty`}>
        <p className="mcp-toggles__note">
          No connectors in this Space yet. <ConnectorsLink>Browse connectors</ConnectorsLink>
        </p>
      </div>
    );
  }

  return (
    <div className="mcp-toggles" data-testid={testId} data-layout={layout}>
      <div className="mcp-toggles__head">
        <span className="mcp-toggles__using" data-testid={`${testId}-using`}>
          {explicit ? 'Using: Custom' : contextualDefaults ? 'Using: Context defaults' : 'Using: Space defaults'}
        </span>
        {/* S23 / §10.4: Reset sends `null` (here, `undefined`), which DELETES
            the stored row rather than writing the current defaults into it —
            the difference between going back to defaults and pinning today's
            defaults forever. Offered only once there is something to reset. */}
        {readOnly ? null : (
          <span className="mcp-toggles__acts">
            {/* ALL OFF IN ONE PRESS, and it is not a convenience: `[]` is a
                third value with its own meaning (§5.3) and the only other way
                to reach it is to switch every row off one at a time, which on
                a Space with a dozen connectors is a chore people abandon
                half-done — leaving a selection nobody meant to make. */}
            {selected.length > 0 ? (
              <button
                type="button"
                className="mcp-toggles__reset"
                data-testid={`${testId}-none`}
                disabled={disabled}
                onClick={() => onChange?.([])}
              >
                Turn all off
              </button>
            ) : null}
            {explicit ? (
              <button
                type="button"
                className="mcp-toggles__reset"
                data-testid={`${testId}-reset`}
                disabled={disabled}
                onClick={() => onChange?.(undefined)}
              >
                {resetLabel}
              </button>
            ) : null}
          </span>
        )}
      </div>
      {/* The defaults are a SPACE-WIDE switch, not this surface's own setting:
          an admin's `defaultOn` joins every launch's defaults in the Space, so
          the words have to say whose decision the viewer is looking at. */}
      <p className="mcp-toggles__note" id={`${id}-help`}>
        {explicit
          ? 'This selection replaces the inherited defaults.'
          : contextualDefaults ? 'Inherited from this entity, its ancestors, your teammate and Space settings.'
          : 'The connectors a Space admin switched on for everyone here.'}
      </p>
      {notice ? <p className="mcp-toggles__note" role="note">{notice}</p> : null}
      {filterable ? (
        <label className="mcp-toggles__filter">
          <span className="mcp-toggles__filter-label">Filter connectors</span>
          <input
            type="search"
            value={filter}
            placeholder="Filter"
            data-testid={`${testId}-filter`}
            onChange={event => setFilter(event.target.value)}
          />
        </label>
      ) : null}
      <ul className="mcp-toggles__rows" aria-describedby={`${id}-help`}>
        {shown.map(row => (
          <Row
            key={row.server.id}
            row={row}
            rowId={`${id}-${row.server.id}`}
            testId={testId}
            disabled={disabled}
            readOnly={readOnly}
            onToggle={on => toggle(row, on)}
            onPinAccount={credentialId => pinAccount(row, credentialId)}
          />
        ))}
        {shown.length === 0 ? (
          <li className="mcp-toggles__note" data-testid={`${testId}-nomatch`}>
            No connector matches “{filter.trim()}”.
          </li>
        ) : null}
      </ul>
      {/* §10.4's "all off" state. `[]` is a choice and says so, because a list
          of switched-off rows looks identical to a Space with no defaults. */}
      {explicit && selected.length === 0 ? (
        <p className="mcp-toggles__note" data-testid={`${testId}-alloff`}>
          No connectors in this chat — this session will have no connectors.
        </p>
      ) : null}
      {problem ? <p className="mcp-error" role="alert">{problem}</p> : null}
      {readOnly ? null : (
        <p className="mcp-toggles__foot">
          <ConnectorsLink>Manage connectors</ConnectorsLink>
        </p>
      )}
    </div>
  );
}

function Row({
  row,
  rowId,
  testId,
  disabled,
  readOnly,
  onToggle,
  onPinAccount,
}: {
  row: ConnectorRow;
  rowId: string;
  testId: string;
  disabled: boolean;
  readOnly: boolean;
  onToggle(on: boolean): void;
  onPinAccount(credentialId: string): void;
}) {
  const { server } = row;
  return (
    <li className="mcp-toggles__row" data-testid={`${testId}-row`} data-status={row.status} data-on={row.on || undefined}>
      <span className="mcp-toggles__name">
        <strong>{server.title}</strong>
        {server.description ? <small>{server.description}</small> : null}
      </span>
      <span className="mcp-toggles__access">{row.access}</span>
      <span className="mcp-toggles__status" data-status={row.status}>
        <span aria-hidden>{row.glyph}</span> {row.text}
        {/* A default that is ON but cannot open is reported, not hidden: the
            server SKIPS it at launch (§7.3 "skipped: not connected") rather
            than failing, and the person is the only one who can fix it. */}
        {row.on && row.status !== 'ready' && row.status !== 'server_unavailable'
          ? <small>On, but it will be skipped until this is fixed.</small>
          : null}
      </span>
      {readOnly ? (
        <span className="mcp-toggles__readonly">{row.on ? 'on' : 'off'}</span>
      ) : (
        <label className="mcp-toggles__switch" htmlFor={rowId}>
          <input
            id={rowId}
            type="checkbox"
            role="switch"
            checked={row.on}
            data-testid={`${testId}-switch-${server.id}`}
            disabled={disabled || !row.toggle}
            aria-label={`${server.title} — ${row.on ? 'on' : 'off'}`}
            title={row.toggle ? undefined : row.text}
            onChange={event => onToggle(event.target.checked)}
          />
          <span aria-hidden>{row.on ? 'on' : 'off'}</span>
        </label>
      )}
      {/*
        * THE ACCOUNT PICKER, for an explicit pick that needs an account.
        *
        * §10.0 asks for it "only when the root has more than one connection",
        * and that is not enough: a connection only SHARED with the viewer is
        * opened by the server only when it is pinned (`resolvedAccount`), so a
        * row whose one account is a share would switch on and never send. It
        * is drawn whenever there is an account to name OR a dead pin to
        * replace (`wantsAccountChoice`), and left out otherwise (the row's
        * action is [Connect] then, which is the real remedy). The control is
        * `AccountSelect`, shared with the launch chips.
        */}
      {!readOnly && wantsAccountChoice(row) ? (
        <label className="mcp-toggles__account">
          <span>Account for {server.title}</span>
          <AccountSelect row={row} disabled={disabled} testId={`${testId}-account-${server.id}`} onPin={onPinAccount} />
        </label>
      ) : null}
      {!readOnly && row.action !== 'none' ? <RowAction row={row} /> : null}
    </li>
  );
}

/**
 * The row's one action. Every live one goes to the Connectors page, because
 * that is where connecting, reconnecting and approving actually happen — this
 * list is not a place to hold an OAuth popup, and §10.2's flow belongs to its
 * own surface.
 *
 * An action with NO surface behind it is drawn as a reason, not as a button:
 * `server_unavailable`'s [Retry test] needs `mcp.servers.test`, which this
 * component is not given a port for, and `stdio_not_trusted` needs the node's
 * own settings. Saying so is the honest form; a button that does nothing is
 * not.
 */
function RowAction({ row }: { row: ConnectorRow }) {
  if (row.action === 'connect') return <ConnectorsLink>Connect {row.server.title}</ConnectorsLink>;
  if (row.action === 'reconnect') return <ConnectorsLink>Reconnect {row.server.title}</ConnectorsLink>;
  if (row.action === 'approve') {
    return row.server.canApprove
      ? <ConnectorsLink>Approve {row.server.title}</ConnectorsLink>
      : <span className="mcp-toggles__why">An admin has to approve it</span>;
  }
  if (row.action === 'test') {
    return <span className="mcp-toggles__why">Test it on the Connectors page</span>;
  }
  return row.server.canManage
    ? <ConnectorsLink>Connector settings</ConnectorsLink>
    : <span className="mcp-toggles__why">An admin has to trust this command</span>;
}
