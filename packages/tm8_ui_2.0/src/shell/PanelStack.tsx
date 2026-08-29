/**
 * PanelStack (LLD §5.2/§5.3) — the center's panel columns.
 *
 * Render order is the law: **pins left-to-right in pin order, stack-top
 * rightmost**. Only the stack TOP renders; the rest of the stack is behind it,
 * which is why the whole stack costs one C_min slot and not one per entry.
 *
 * Esc pops the stack top ONLY — never a pin, which is dismissed explicitly.
 * The guard matters: §7's layer chain means Esc belongs to a modal, palette, or
 * focused terminal first, so this listener steps aside when a higher layer owns
 * the keyboard. Until the C6 controller lands (a separate lane), that check is
 * an injected predicate rather than an assumption.
 */
import { useEffect } from 'react';
import type { EntityId } from '@tm8/contract';
import type { NavPort } from './nav-port';
import { selectPanelIds } from './nav-port';

export interface PanelStackProps {
  nav: NavPort;
  /**
   * Renders one panel. Supplied by the caller so this component never depends
   * on A1c's `EntityDetailPanel` — it owns placement, not panel anatomy.
   */
  renderPanel(id: EntityId, host: 'pinned' | 'stack'): React.ReactNode;
  /**
   * Esc is a LAYERED key (§7). Returns true when a higher layer — modal,
   * palette, text entry, focused terminal — currently owns it. Defaults to
   * "nothing above us", which is correct only until the keyboard controller
   * exists; it is a parameter precisely so that lane can take it over without
   * touching this file.
   */
  isKeyboardOwnedAbove?(): boolean;
  onPopped?(id: EntityId): void;
}

export function PanelStack({ nav, renderPanel, isKeyboardOwnedAbove, onPopped }: PanelStackProps) {
  const stackTop = nav.stack[nav.stack.length - 1];

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (isKeyboardOwnedAbove?.()) return;
      // Esc with an empty stack is NOT ours to consume — a pin must never be
      // closed by Esc, so we let the event continue rather than swallowing it.
      if (nav.stack.length === 0) return;
      const popped = nav.stack[nav.stack.length - 1];
      event.preventDefault();
      event.stopPropagation();
      nav.pop();
      if (popped !== undefined) onPopped?.(popped);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [nav, isKeyboardOwnedAbove, onPopped]);

  const columns = selectPanelIds(nav);

  if (columns.length === 0) {
    // 02-LAYOUT §2.2 — the empty center is a real state (live-session roster +
    // grammar hint), not a blank. Its content is the workspace view's; the
    // stack only guarantees the slot exists and keeps its C_min floor.
    return (
      <div className="shell-stack shell-stack--empty" data-testid="panel-stack" data-slots="0" />
    );
  }

  return (
    <div className="shell-stack" data-testid="panel-stack" data-slots={columns.length}>
      {columns.map((id) => {
        const pinned = id !== stackTop || nav.pinned.includes(id);
        return (
          <div
            key={id}
            className="shell-stack__col"
            data-panel-id={id}
            data-host={pinned ? 'pinned' : 'stack'}
          >
            {renderPanel(id, pinned ? 'pinned' : 'stack')}
          </div>
        );
      })}
    </div>
  );
}
