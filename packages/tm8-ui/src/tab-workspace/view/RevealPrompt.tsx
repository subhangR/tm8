/**
 * The blocking interaction prompt: the scope reveal choice (Spec A §7) and
 * the unsaved-changes confirmation (§6). Renders `state.pending`; answers go
 * through `interactions.resolve`. Workstream D (reveal) / C (unsaved).
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { getKindAdapter } from '../adapters/registry';
import type { InteractionChoice, PendingInteraction } from '../runtime/types';
import { useWorkspace, useWorkspaceState } from './context';
import { trapTab } from './ScopePicker';
import './scope.css';

export function RevealPrompt() {
  const { dispatch } = useWorkspace();
  const pending = useWorkspaceState((s) => s.pending);
  // Always on: the press that triggers a prompt happens before it mounts.
  useRecordPresses();
  // unsaved_changes is ConfirmDiscard's (workstream C).
  if (!pending || pending.reason === 'unsaved_changes') return null;
  if (pending.reason === 'scope_choice_required') return <ScopeReveal key={pending.id} pending={pending} />;
  const plural = pending.targetKind ? getKindAdapter(pending.targetKind).nounPlural : '';
  const label: Record<InteractionChoice, string> = {
    addType: `Add ${plural} and open`,
    useMixed: 'Use Mixed and open',
    cancel: 'Cancel',
    discard: 'Discard draft',
    keep: 'Keep editing',
  };
  return (
    <div className="tws-prompt" role="dialog" aria-modal="false" data-testid="tws-prompt" data-reason={pending.reason}>
      {pending.choices.map((choice) => (
        <button
          key={choice}
          type="button"
          className="tws-quiet-btn"
          onClick={() =>
            dispatch({
              command: 'workspace.interactions.resolve',
              args: { interactionId: pending.id, choice },
              source: 'click',
            })
          }
        >
          {label[choice]}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scope reveal (Spec A §7; design log §9)
// ---------------------------------------------------------------------------

/**
 * The prompt anchors to whatever the person just pressed (a list row, a
 * crumb, a tab, + New, a chooser pick). Pending carries no anchor, so the
 * last press inside the Workspace is remembered; a prompt with no recent
 * press (deep link, restore) anchors to the strip's scope control.
 */
const ANCHOR_WINDOW_MS = 1500;
const ANCHOR_SELECTOR = '[role="tab"], [role="row"], [role="option"], [role="treeitem"], button, a, li';
const EDGE = 8;
const GAP = 4;

let lastPress: { element: Element; at: number } | null = null;
let pressListeners = 0;
const recordPress = (event: Event) => {
  if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return;
  if (event.target instanceof Element) lastPress = { element: event.target, at: Date.now() };
};

function useRecordPresses() {
  useEffect(() => {
    if (pressListeners++ === 0) {
      document.addEventListener('pointerdown', recordPress, true);
      document.addEventListener('keydown', recordPress, true);
    }
    return () => {
      if (--pressListeners === 0) {
        document.removeEventListener('pointerdown', recordPress, true);
        document.removeEventListener('keydown', recordPress, true);
      }
    };
  }, []);
}

function findAnchor(root: Element | null): HTMLElement | null {
  const press = lastPress;
  if (root && press && Date.now() - press.at < ANCHOR_WINDOW_MS && press.element.isConnected && root.contains(press.element)) {
    const target = press.element.closest(ANCHOR_SELECTOR) ?? press.element;
    if (target instanceof HTMLElement && !target.closest('.tws-reveal')) return target;
  }
  return root?.querySelector<HTMLElement>('[data-testid="tws-scope"]') ?? null;
}

/** Below the anchor, left edges aligned; above it when there is no room; clamped to the window. */
function placeNear(anchor: DOMRect | null, box: DOMRect): CSSProperties {
  if (!anchor) return { top: EDGE, right: EDGE };
  const maxLeft = window.innerWidth - box.width - EDGE;
  const left = Math.max(EDGE, Math.min(anchor.left, maxLeft));
  const below = anchor.bottom + GAP;
  const top = below + box.height <= window.innerHeight - EDGE ? below : Math.max(EDGE, anchor.top - GAP - box.height);
  return { top, left };
}

function ScopeReveal({ pending }: { pending: PendingInteraction }) {
  const { dispatch } = useWorkspace();
  const boxRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  const textId = useId();

  const plural = pending.targetKind ? getKindAdapter(pending.targetKind).nounPlural : 'These tabs';

  const resolve = (choice: InteractionChoice, source: 'click' | 'keyboard', returnFocus: boolean) => {
    const anchor = anchorRef.current;
    dispatch({ command: 'workspace.interactions.resolve', args: { interactionId: pending.id, choice }, source });
    // Popovers return focus to their trigger (Spec A §16).
    if (returnFocus && anchor?.isConnected) anchor.focus();
  };
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    anchorRef.current = findAnchor(box.closest('.tws-root'));
    const place = () => {
      const anchor = anchorRef.current?.isConnected ? anchorRef.current.getBoundingClientRect() : null;
      setPosition(placeNear(anchor, box.getBoundingClientRect()));
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, []);

  useEffect(() => {
    boxRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    // An outside press cancels, like the scope popover; it does not move focus.
    const onPointerDown = (event: PointerEvent) => {
      if (boxRef.current?.contains(event.target as Node)) return;
      resolveRef.current('cancel', 'click', false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, []);

  const label: Partial<Record<InteractionChoice, string>> = {
    addType: `Add ${plural} and open`,
    useMixed: 'Use Mixed and open',
    cancel: 'Cancel',
  };
  const order: InteractionChoice[] = ['addType', 'useMixed', 'cancel'];

  return (
    <div
      ref={boxRef}
      className="tws-reveal"
      role="dialog"
      aria-labelledby={textId}
      style={position}
      data-testid="tws-prompt"
      data-reason={pending.reason}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && pending.choices.includes('cancel')) {
          event.preventDefault();
          event.stopPropagation();
          resolve('cancel', 'keyboard', true);
          return;
        }
        trapTab(event, boxRef.current);
      }}
    >
      <p id={textId} className="tws-reveal-text">
        {plural} are hidden by your tab scope.
      </p>
      <div className="tws-reveal-actions">
        {order
          .filter((choice) => pending.choices.includes(choice))
          .map((choice) => (
            <button
              key={choice}
              type="button"
              className="tws-reveal-btn"
              data-choice={choice}
              onClick={(event) => resolve(choice, event.detail === 0 ? 'keyboard' : 'click', true)}
            >
              {label[choice]}
            </button>
          ))}
      </div>
    </div>
  );
}
