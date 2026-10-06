/**
 * Tab scope control and popover (Spec A §7, §16; design log §5, §8).
 * Workstream D.
 *
 * The control reads `Mixed ▾` or `By type · N ▾`. The popover stages its
 * edits locally and dispatches `workspace.tabScope.set` only on Apply;
 * Cancel, Escape and an outside click discard them. Applied scope changes —
 * from Apply or from the reveal prompt — are announced in a live region.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { KindIcon } from '../../domain';
import { workspaceKindAdapters, getKindAdapter } from '../adapters/registry';
import { UI_SOURCES, type KindId, type TabScope } from '../runtime/types';
import { useWorkspace, useWorkspaceState } from './context';
import './scope.css';

/** Show the type filter once the list is longer than the popover's 8 visible rows. */
const SEARCH_THRESHOLD = 8;
const POPOVER_GAP = 4;

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Keep Tab / Shift+Tab inside `container` (Spec A §16: popovers trap focus). */
export function trapTab(event: { key: string; shiftKey: boolean; preventDefault(): void }, container: HTMLElement | null) {
  if (event.key !== 'Tab' || !container) return;
  const items = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)];
  if (items.length === 0) return;
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !container.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !container.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

/** "Tasks", "Tasks and Agents", "Tasks, Agents and Docs". */
export function kindList(kinds: readonly KindId[]): string {
  const names = kinds.map((kind) => getKindAdapter(kind).nounPlural);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function scopeSentence(scope: TabScope): string {
  return scope.mode === 'mixed' ? 'Showing all open tabs' : `Showing ${kindList(scope.selectedTypeIds)}`;
}

function sameIds(a: readonly KindId[], b: readonly KindId[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

export function ScopePicker() {
  const { runtime, dispatch } = useWorkspace();
  const scope = useWorkspaceState((s) => s.scope);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const descriptionId = useId();

  const label = scope.mode === 'mixed' ? 'Mixed' : `By type · ${scope.selectedTypeIds.length}`;
  const tooltip = scopeSentence(scope);

  // Announce scope changes a person applied (Apply here, or a reveal-prompt
  // answer), not restores or agent writes.
  useEffect(
    () =>
      runtime.registerEffect(({ env, prev, next }) => {
        if (prev.scope === next.scope || !UI_SOURCES.includes(env.source)) return;
        if (env.command !== 'workspace.tabScope.set' && env.command !== 'workspace.interactions.resolve') return;
        setAnnouncement(scopeSentence(next.scope));
      }),
    [runtime],
  );

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  return (
    <div className="tws-scope">
      <button
        ref={triggerRef}
        type="button"
        className="tws-scope-btn"
        data-mode={scope.mode}
        aria-label="Workspace tab scope"
        aria-describedby={descriptionId}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={tooltip}
        data-testid="tws-scope"
        onClick={() => setOpen((was) => !was)}
      >
        <span>{label}</span>
        <span className="tws-scope-chevron" aria-hidden="true">
          ▾
        </span>
      </button>
      <span id={descriptionId} className="tws-sr-only">
        {tooltip}
      </span>
      <span className="tws-sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
      {open ? (
        <ScopePopover
          scope={scope}
          triggerRef={triggerRef}
          onDismiss={close}
          onApply={(request) => {
            dispatch({ command: 'workspace.tabScope.set', args: request.args, source: request.source });
            close(true);
          }}
        />
      ) : null}
    </div>
  );
}

type ApplyRequest = {
  args: { mode: 'mixed' } | { mode: 'byType'; selectedTypeIds: KindId[] };
  source: 'click' | 'keyboard';
};

function ScopePopover({
  scope,
  triggerRef,
  onDismiss,
  onApply,
}: {
  scope: TabScope;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onDismiss(returnFocus: boolean): void;
  onApply(request: ApplyRequest): void;
}) {
  const adapters = useMemo(() => workspaceKindAdapters(), []);
  const [mode, setMode] = useState<TabScope['mode']>(scope.mode);
  const [ids, setIds] = useState<KindId[]>(() => (scope.mode === 'mixed' ? scope.lastByTypeIds : scope.selectedTypeIds));
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  const boxRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const statusId = useId();

  // Anchored under the trigger, right edges aligned (design log §8). Fixed,
  // so the strip's overflow never clips it.
  useLayoutEffect(() => {
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition({ top: rect.bottom + POPOVER_GAP, right: Math.max(window.innerWidth - rect.right, POPOVER_GAP) });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [triggerRef]);

  useEffect(() => {
    boxRef.current?.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.focus();
  }, []);

  // An outside press discards the staged edits; it does not move focus.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (boxRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      onDismiss(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [onDismiss, triggerRef]);

  const selected = useMemo(() => new Set(ids), [ids]);
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? adapters.filter((a) => a.nounPlural.toLowerCase().includes(needle) || a.noun.toLowerCase().includes(needle))
    : adapters;
  const invalid = mode === 'byType' && ids.length === 0;
  const inMixed = mode === 'mixed';

  const toggle = (kind: KindId) =>
    setIds((prev) => (prev.includes(kind) ? prev.filter((id) => id !== kind) : [...prev, kind].sort()));

  const apply = (source: ApplyRequest['source']) => {
    if (invalid) return;
    const sorted = [...ids].sort();
    const unchanged =
      mode === scope.mode && (mode === 'mixed' || (scope.mode === 'byType' && sameIds(sorted, scope.selectedTypeIds)));
    if (unchanged) return onDismiss(true);
    onApply({ args: mode === 'mixed' ? { mode: 'mixed' } : { mode: 'byType', selectedTypeIds: sorted }, source });
  };

  return (
    <div
      ref={boxRef}
      className="tws-scope-pop"
      role="dialog"
      aria-labelledby={titleId}
      style={position}
      data-testid="tws-scope-popover"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onDismiss(true);
          return;
        }
        trapTab(event, boxRef.current);
      }}
    >
      <span id={titleId} className="tws-sr-only">
        Workspace tab scope
      </span>
      <fieldset className="tws-scope-modes" role="radiogroup">
        <legend className="tws-sr-only">Which tabs the strip shows</legend>
        <label className="tws-scope-mode">
          <input type="radio" name={`${titleId}-mode`} checked={mode === 'mixed'} onChange={() => setMode('mixed')} />
          <span>
            Mixed<span className="tws-scope-hint"> — show all open tabs</span>
          </span>
        </label>
        <label className="tws-scope-mode">
          <input type="radio" name={`${titleId}-mode`} checked={mode === 'byType'} onChange={() => setMode('byType')} />
          <span>
            By type<span className="tws-scope-hint"> — show selected kinds</span>
          </span>
        </label>
      </fieldset>

      <fieldset className="tws-scope-kinds" disabled={inMixed} aria-describedby={statusId}>
        <legend className="tws-sr-only">Entity types</legend>
        {adapters.length > SEARCH_THRESHOLD ? (
          <input
            type="search"
            className="tws-scope-filter"
            placeholder="Filter types"
            aria-label="Filter types"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        ) : null}
        <div className="tws-scope-list">
          {shown.map((adapter) => (
            <label key={adapter.kind} className="tws-scope-kind">
              <input type="checkbox" checked={selected.has(adapter.kind)} onChange={() => toggle(adapter.kind)} />
              <KindIcon kind={adapter.kind} size={14} />
              <span>{adapter.nounPlural}</span>
            </label>
          ))}
          {shown.length === 0 ? <p className="tws-scope-empty">No types match “{query.trim()}”</p> : null}
        </div>
      </fieldset>

      <p id={statusId} className="tws-scope-status" data-invalid={invalid || undefined} aria-live="polite">
        {invalid ? (
          <>
            <span className="tws-scope-alert" aria-hidden="true">
              !
            </span>
            Select at least one entity type
          </>
        ) : (
          `${ids.length} ${ids.length === 1 ? 'type' : 'types'} selected`
        )}
      </p>

      <div className="tws-scope-foot">
        <button type="button" className="tws-scope-cancel" onClick={() => onDismiss(true)}>
          Cancel
        </button>
        <button
          type="button"
          className="tws-scope-apply"
          disabled={invalid}
          onClick={(event) => apply(event.detail === 0 ? 'keyboard' : 'click')}
        >
          Apply
        </button>
      </div>
    </div>
  );
}
