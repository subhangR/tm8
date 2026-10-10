import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { EntitySummary, MoveEntityInput } from '@tm8/contract';
import './entity-placement.css';

export type RelativePlacement = NonNullable<MoveEntityInput['placement']>;
export type MoveEntity = (row: EntitySummary, placement: RelativePlacement) => Promise<unknown>;
type Action = 'up' | 'down' | 'indent' | 'outdent';

/** Only known ancestors are checked here; the database validates the full tree. */
export function validPlacement(rows: readonly EntitySummary[], row: EntitySummary, target: EntitySummary): boolean {
  if (row.spaceId !== target.spaceId || row.kind !== target.kind) return false;
  const index = new Map(rows.map((r) => [r.id, r]));
  const seen = new Set<string>();
  let ancestor: EntitySummary | undefined = target;
  while (ancestor) {
    if (ancestor.id === row.id || seen.has(ancestor.id)) return false;
    seen.add(ancestor.id);
    ancestor = ancestor.parentId ? index.get(ancestor.parentId) : undefined;
  }
  return true;
}

export function placementAction(rows: readonly EntitySummary[], row: EntitySummary, action: Action): RelativePlacement | null {
  const siblings = rows.filter((r) => r.parentId === row.parentId);
  const index = siblings.findIndex((r) => r.id === row.id);
  const previous = siblings[index - 1];
  const next = siblings[index + 1];
  if (action === 'up') return previous ? { targetId: previous.id, relation: 'before' } : null;
  if (action === 'down') return next ? { targetId: next.id, relation: 'after' } : null;
  if (action === 'indent') return previous ? { targetId: previous.id, relation: 'inside' } : null;
  return row.parentId ? { targetId: row.parentId, relation: 'after' } : null;
}

/** Adds interaction to the existing card's ancestor; never replaces the card. */
export function useEntityPlacement({ rows, selectedId, canMove, move, createChild, disabledReason }: {
  rows: readonly EntitySummary[];
  selectedId?: string | null;
  canMove: (id: string) => boolean;
  move?: MoveEntity;
  createChild?: (parent: EntitySummary) => void;
  disabledReason?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const latest = useRef({ rows, canMove, move, disabledReason });
  latest.current = { rows, canMove, move, disabledReason };
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<{ id: string; relation: string } | null>(null);
  const perform = useRef(async (_row: EntitySummary, _placement: RelativePlacement) => {});
  perform.current = async (row, placement) => {
    if (busy.current || !move || !canMove(row.id) || disabledReason) return;
    busy.current = true; setPending(true); setMenu(null); setNotice('');
    try {
      await move(row, placement);
      setNotice(`Moved ${row.title}.`);
    } catch (error) {
      setNotice(`Could not move ${row.title}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      busy.current = false; setPending(false);
    }
  };

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let hold: ReturnType<typeof setTimeout> | undefined;
    let pointer: { id: number; x: number; y: number; row: EntitySummary } | null = null;
    let active = false;
    let suppressClick = false;
    let releaseClick: ReturnType<typeof setTimeout> | undefined;
    let target: RelativePlacement | null = null;
    let boxes: { row: EntitySummary; rect: DOMRect }[] = [];
    const clear = () => {
      clearTimeout(hold); hold = undefined;
      if (active) {
        // Covers the synthetic click dispatched after pointerup, but never the
        // next deliberate click after Escape/blur/pointer cancellation.
        suppressClick = true;
        clearTimeout(releaseClick);
        releaseClick = setTimeout(() => { suppressClick = false; }, 0);
      }
      pointer = null; active = false; target = null; boxes = [];
      element.removeAttribute('data-placement-dragging');
      setPreview(null);
    };
    const rowAt = (event: Event) => {
      const node = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-placement-row]') : null;
      return latest.current.rows.find((r) => r.id === node?.dataset.placementRow);
    };
    const interactive = (event: Event) => event.target instanceof Element
      && event.target.closest('button, a, input, textarea, select, [contenteditable="true"], [role="menu"], [role="checkbox"]');
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || interactive(event) || busy.current || latest.current.disabledReason) return;
      const row = rowAt(event);
      if (!row || !latest.current.move || !latest.current.canMove(row.id)) return;
      clear(); suppressClick = false;
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, row };
      hold = setTimeout(() => {
        if (!pointer) return;
        active = true; suppressClick = true;
        element.setAttribute('data-placement-dragging', 'true');
        setNotice(`Moving ${row.title}. Drop at an edge to reorder, or in the center to indent. Escape cancels.`);
        // Fixed geometry during pickup; previews never reshuffle the hit map.
        boxes = [...element.querySelectorAll<HTMLElement>('[data-placement-row]')].flatMap((node) => {
          const candidate = latest.current.rows.find((r) => r.id === node.dataset.placementRow);
          const card = node.querySelector<HTMLElement>('[data-testid="list-tile"]') ?? node.firstElementChild;
          return candidate && card && validPlacement(latest.current.rows, row, candidate)
            ? [{ row: candidate, rect: card.getBoundingClientRect() }] : [];
        });
      }, 450);
    };
    const motion = (event: PointerEvent) => {
      if (!pointer || pointer.id !== event.pointerId) return;
      if (!active) {
        if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 8) clear();
        return;
      }
      event.preventDefault();
      const hit = boxes.find(({ rect }) => event.clientY >= rect.top && event.clientY <= rect.bottom
        && event.clientX >= rect.left && event.clientX <= rect.right);
      if (!hit) { target = null; setPreview(null); return; }
      const fraction = (event.clientY - hit.rect.top) / Math.max(hit.rect.height, 1);
      const relation = fraction < 0.25 ? 'before' : fraction > 0.75 ? 'after' : 'inside';
      target = { targetId: hit.row.id, relation };
      setPreview({ id: hit.row.id, relation });
    };
    const up = (event: PointerEvent) => {
      if (pointer?.id !== event.pointerId) return;
      const row = pointer.row; const placement = active ? target : null;
      if (active) event.preventDefault();
      clear();
      if (placement) void perform.current(row, placement);
    };
    const click = (event: MouseEvent) => {
      if (suppressClick) { event.preventDefault(); event.stopPropagation(); suppressClick = false; }
    };
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { clear(); setMenu(null); return; }
      const row = rowAt(event);
      if (!row || interactive(event) || !latest.current.move || !latest.current.canMove(row.id)) return;
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault();
        const rect = (event.target as Element).getBoundingClientRect();
        setMenu({ id: row.id, x: rect.left, y: rect.top }); return;
      }
      if (!event.altKey || latest.current.disabledReason) return;
      const action = ({ ArrowUp: 'up', ArrowDown: 'down', ArrowRight: 'indent', ArrowLeft: 'outdent' } as const)[event.key as 'ArrowUp'];
      if (!action) return;
      event.preventDefault(); event.stopPropagation();
      const placement = placementAction(latest.current.rows, row, action);
      if (placement) void perform.current(row, placement);
    };
    const context = (event: MouseEvent) => {
      // Touch browsers may emit a native context menu after the hold timer.
      // Keep an active drag instead of replacing it with the explicit menu.
      if (active) { event.preventDefault(); return; }
      const row = rowAt(event);
      if (!row || interactive(event) || !latest.current.move || !latest.current.canMove(row.id)) return;
      event.preventDefault(); clear(); setMenu({ id: row.id, x: event.clientX, y: event.clientY });
    };
    const touch = (event: TouchEvent) => { if (active) event.preventDefault(); };
    element.addEventListener('pointerdown', down);
    element.addEventListener('click', click, true);
    element.addEventListener('keydown', keys, true);
    element.addEventListener('contextmenu', context);
    window.addEventListener('pointermove', motion, { passive: false });
    window.addEventListener('touchmove', touch, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', clear);
    window.addEventListener('blur', clear);
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') clear(); };
    window.addEventListener('keydown', escape);
    return () => {
      clear(); clearTimeout(releaseClick);
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('click', click, true);
      element.removeEventListener('keydown', keys, true);
      element.removeEventListener('contextmenu', context);
      window.removeEventListener('pointermove', motion);
      window.removeEventListener('touchmove', touch);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', clear);
      window.removeEventListener('blur', clear);
      window.removeEventListener('keydown', escape);
    };
  }, []);

  const row = rows.find((r) => r.id === menu?.id);
  const selected = rows.find((r) => r.id === selectedId);
  let controls: ReactNode = null;
  if (move) controls = <>
    <div className="lp-placement-toolbar">
      <button type="button" disabled={!selected || !canMove(selected.id) || pending || Boolean(disabledReason)}
        title={disabledReason ?? 'Select a card, then move it. Cards also support long press and Alt+arrows.'}
        onClick={(event) => {
          if (!selected) return;
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu({ id: selected.id, x: rect.left, y: rect.bottom });
        }}>Move selected…</button>
      {createChild && selected ? <button type="button" onClick={() => createChild(selected)}>Add child</button> : null}
      <span role="status" aria-live="polite">{pending ? 'Saving placement…' : notice}</span>
    </div>
    {menu && row ? <div className="lp-placement-scrim" onClick={() => setMenu(null)}>
      <div role="dialog" aria-label={`Move ${row.title}`} className="lp-placement-menu"
        style={{ left: Math.max(8, Math.min(menu.x, window.innerWidth - 280)), top: Math.max(8, Math.min(menu.y, window.innerHeight - 360)) }}
        onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape') setMenu(null); }}>
        <strong>Move {row.title}</strong>
        {(['up', 'down', 'indent', 'outdent'] as const).map((action) => {
          const placement = placementAction(rows, row, action);
          return <button key={action} type="button" disabled={!placement || pending || Boolean(disabledReason)}
            onClick={() => { if (placement) void perform.current(row, placement); }}>
            {({ up: 'Move up', down: 'Move down', indent: 'Indent', outdent: 'Outdent' })[action]}
          </button>;
        })}
        <label>Move to…<select autoFocus defaultValue="" disabled={pending || Boolean(disabledReason)} onChange={(event) => {
          if (event.target.value) void perform.current(row, { targetId: event.target.value === 'root' ? null : event.target.value, relation: 'inside' });
        }}><option value="" disabled>Choose a parent</option><option value="root">Top level</option>
          {rows.filter((candidate) => validPlacement(rows, row, candidate)).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}
        </select></label>
        <small>Choose from loaded rows. Moves include all children.</small>
        {disabledReason ? <p>{disabledReason}</p> : null}
        <button type="button" onClick={() => setMenu(null)}>Cancel</button>
      </div>
    </div> : null}
  </>;
  return { root, controls, preview };
}
