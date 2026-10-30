/**
 * THE CONNECTOR PICKER A LAUNCH OR A CHAT MOUNTS — one read, one gate, one
 * count, and the layout the host asked for.
 *
 * Inputs: the scope (`targetId`, `teamMemberId`), the selection the host holds
 * (`undefined` = the Space's defaults, `[]` = none, a list = exactly these) and
 * `onChange`. Outputs, reported from layout effects so a host never paints a
 * stale answer:
 *  - `onReady(ready, problem)` — the gate (`selection-gate.ts`): false only for
 *    an explicit pick `bind` would refuse, with the sentence that names it,
 *    or an explicit non-empty pick still waiting on this mount's first read
 *    ("Checking connectors…"). An untouched or empty selection never waits,
 *    and a failed read ends the wait. A host shows
 *    `problem` as its refusal (`usePickerGate` keeps both for it).
 *  - `onCount(n)` — how many connectors it offers; 0 exactly when it draws
 *    nothing but, at most, its one loading line.
 * Callers: the launch card (`compact`), the new-session screen (`grid`), the
 * chat composer (`headless`, the send gate only).
 *
 * It owns no presentation of its own beyond choosing one: the rows are
 * `ConnectorToggleList`'s, the chips `ConnectorChips`'.
 */
import { useCallback, useLayoutEffect, useId, useState, type ReactNode } from 'react';
import { ConnectorChips } from './ConnectorChips';
import { ConnectorToggleList } from './ConnectorToggleList';
import { useMcpCatalog } from './context';
import { connectorRows } from './row-model';
import { OPEN_GATE, selectionGate, type SelectionGate } from './selection-gate';
import type { McpSelection } from './port';
import './mcp.css';

/**
 * The gate's WAIT sentence: an explicit pick held until this mount's own read.
 * A host that draws the picker holds its launch on it but need not repeat it
 * as a refusal — the picker draws it as a quiet status line.
 */
export const CHECKING_CONNECTORS = 'Checking connectors…';
const CHECKING: SelectionGate = { blocked: true, problem: CHECKING_CONNECTORS };

/**
 * A host's state for the picker's verdict: the gate, and a STABLE `onReady`
 * that stores it. Stable because the picker reports from a layout effect keyed
 * on `onReady`, so a fresh arrow per render would report, set state and render
 * again forever.
 */
export function usePickerGate(): [SelectionGate, (ready: boolean, problem: string | null) => void] {
  const [gate, setGate] = useState<SelectionGate>(OPEN_GATE);
  const onReady = useCallback((ready: boolean, problem: string | null) => {
    setGate(current => (current.blocked === !ready && current.problem === problem
      ? current
      : ready ? OPEN_GATE : { blocked: true, problem }));
  }, []);
  return [gate, onReady];
}

/**
 * Renders nothing unless there is a connector to choose or a problem to fix.
 *
 * G15: IT NEVER SENDS A TRIMMED DEFAULT LIST. It used to notice that some
 * default had no connected account and call `onChange(usableDefaults(catalog))`
 * from a layout effect — which turned "the user chose nothing" into an explicit
 * selection, computed from whatever the browser could see. §5.3's rule is the
 * opposite: the field is sent ONLY when the user changed something, so defaults
 * resolve server-side at launch, under the provenance root's own claims, with
 * §3's account order and a `skipped: not connected` report for the ones it
 * cannot open. The browser's view of "usable" was never the authority, and
 * sending it meant a connector connected between the page load and the launch
 * was silently left off.
 *
 * The gate is open before the catalog arrives for an unedited picker for the
 * same reason: it resolves server-side, so no host waits on this read to
 * launch. An edited one (a chat thread's stored picks, say) waits for it.
 */
export function McpPicker({ targetId, teamMemberId, value, onChange, onReady, onCount, disabled = false, headless = false, retryClassName,
  layout = 'list', notice, resetLabel }: {
  targetId?: string; teamMemberId?: string; value: McpSelection[] | undefined;
  onChange(value: McpSelection[] | undefined): void;
  /** `problem` is the gate's sentence when `ready` is false, null otherwise. */
  onReady?(ready: boolean, problem: string | null): void;
  /**
   * How many connectors the picker offers: every one the viewer may attach
   * here, which is what the full list draws — or 1 when it draws only a
   * selection problem (an explicit pick whose connector is gone) or only its
   * read-failure line, either of which still needs the host's chrome. 0
   * exactly when the picker draws nothing but, at most, its one loading line.
   * A host hides its own chrome at 0 and
   * KEEPS THIS NODE MOUNTED: the count is reported from here, so an unmounted
   * picker can never announce the connectors that arrive later.
   */
  onCount?(count: number): void;
  disabled?: boolean;
  /** Keep the readiness reporting, draw nothing (the picker is drawn elsewhere, e.g. in ＋). */
  headless?: boolean;
  retryClassName?: string;
  /**
   * `grid` is §10.5's two-column launch list; `compact` the launch card's one
   * row of chips, drawn from the scope's last-known catalog first and
   * revalidated on mount, with the full list one press away.
   */
  layout?: 'list' | 'grid' | 'compact';
  /** §10.5's harness ⓘ line, passed through to the shared list. */
  notice?: ReactNode;
  resetLabel?: string;
}) {
  const { phase, catalog, error, port, refresh, seeded } = useMcpCatalog(targetId, teamMemberId, { lastKnown: layout === 'compact' });
  const id = useId();
  // An EXPLICIT pick is judged only against this mount's own read — never
  // against nothing, never against the last-known photograph — on every
  // layout: until that read answers it waits with a named reason, so a
  // first-frame press (or a chat thread's stored dead pick) cannot pass here
  // and meet the server's raw refusal. An untouched or empty selection is the
  // server's to resolve and never waits; a failed read ends the wait.
  const waiting = (value?.length ?? 0) > 0 && (phase === 'loading' || (seeded && phase === 'revalidating'));
  const gate = waiting ? CHECKING : !catalog ? OPEN_GATE : selectionGate(catalog, value);
  // `[]` is never judged: bind cannot refuse "no connectors".
  const rows = catalog?.canAttach ? connectorRows(catalog, value ?? catalog.defaults, value !== undefined) : [];
  // A connector waiting on an admin is shown in the full list (inert), but it
  // is not an option: a scope holding only those offers nothing.
  const attachable = rows.filter(row => row.on || row.actionable).map(row => row.server);
  // What is drawn decides the count, never the other way round.
  const draws = !!port && !headless && !!catalog?.canAttach && (attachable.length > 0 || gate.problem !== null);
  // The one error line counts too: a failed read is drawn, and the host must
  // show the chrome around it rather than hide what explains the gap.
  const failedLine = !!port && !headless && phase === 'failed';
  const count = draws ? Math.max(attachable.length, 1) : failedLine ? 1 : 0;
  useLayoutEffect(() => { onReady?.(!gate.blocked, gate.problem); }, [gate.blocked, gate.problem, onReady]);
  useLayoutEffect(() => { onCount?.(count); }, [count, onCount]);
  if (!port || headless) return null;
  const readError = error
    ? <p className="mcp-error mcp-compact__line" role="alert" data-testid="mcp-picker-error">{error} <button type="button" className={retryClassName} onClick={refresh}>Retry connectors</button></p>
    : null;
  if (layout === 'compact') {
    if (phase === 'loading') return <p className="mcp-compact__line mcp-compact__quiet" role="status" data-testid="mcp-compact-loading">Loading connectors…</p>;
    if (!catalog || !draws) return readError;
    // A failed RE-read keeps the chips it was showing, with one line saying so.
    const checking = gate === CHECKING;
    return <ConnectorChips catalog={catalog} value={value} onChange={onChange} disabled={disabled}
      problem={checking ? null : gate.problem} pending={checking ? gate.problem : null}
      readError={readError} {...(notice ? { notice } : {})} {...(resetLabel ? { resetLabel } : {})} />;
  }
  if (!catalog) return readError;
  if (!draws) return null;
  // A list or grid never holds a catalog under `failed` (only `lastKnown`
  // readers keep one), so no read error is drawn beside it.
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
        {...(gate.problem ? { problem: gate.problem } : {})}
      />
    </details>
  </fieldset>;
}
