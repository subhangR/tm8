/**
 * THE ENTITY-DETAIL FAB — the phone's replacement for the panel bar's tab strip.
 *
 * The phone detail panel spent ~260px of an 844px screen on chrome before any
 * content, and the tab row was the band that could go: two of its three tabs are
 * destinations that ALREADY open as `MobileSheet` on this shell, and the kind's
 * primary verbs already have a registry to be read from. Ruling 2026-08-20 moves
 * both into a floating button.
 *
 * ── THIS FILE IS WIRED TO NOTHING, AND THAT IS THE DESIGN ──────────────────
 *
 * It knows about `EntityFabItem`s and nothing else. It never reads a kind, an
 * action ref, a registry or a config — `id` is OPAQUE here and travels through
 * to `data-fab-item` untouched, which is the seam the mounting lane's tests
 * assert on. §15.2 bans kind and action-id literals in components; a primitive
 * that cannot express one cannot break the ban.
 *
 * ── NOTHING IS MOUNTED OFF THE PHONE, BY CONSTRUCTION ──────────────────────
 *
 * `useMobileSurface().oneSurface` is false wherever there is no phone shell, and
 * this returns `null` there. That is the whole desktop safety argument, and it is
 * deliberately stronger than a stylesheet: the element is not in the desktop DOM
 * at all, rather than present and hidden by a selector somebody has to keep
 * correct. A host may therefore render `<EntityFab>` UNCONDITIONALLY beside its
 * desktop chrome — the same property that lets `MobileSheet` be mounted the same
 * way.
 *
 * ── WHERE A HOST MUST MOUNT IT ─────────────────────────────────────────────
 *
 * Inside the view's POSITIONED, NON-SCROLLING root — the containing block
 * `.ev-fab`, the launch sheet and the edit dialog already use. Two reasons, and
 * the first is the one that has already cost this shell a defect:
 *
 *   · `position: fixed` is measured against the VIEWPORT, which is not the frame.
 *     The frame is shortened by `--mobile-keyboard-inset`, so a fixed control
 *     stays put while the screen it belongs to shrinks — and lands under the
 *     soft keyboard (`mobile-screens.css:853`, where `.ev-fab` states this).
 *   · An absolute layer inside a SCROLLER scrolls with the content. This layer
 *     covers the frame at rest and must not travel.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { RibbonMark } from '../kit';
import { useMobileSurface } from './surface';
import './entity-fab.css';

/**
 * THE SEGMENT BUDGET FOR THE TRIGGER'S MARK.
 *
 * `RibbonMark` rebuilds a z-sorted polygon band through React on every frame, so
 * the count is a per-mount budget rather than a constant — 150 quads at glyph
 * size cover a third of a pixel of arc each, which is under the device's own
 * sampling grid and so cannot be seen, only paid for.
 *
 * 60 is the larger of the two budgets the chat surfaces ship (`WAIT_SEGMENTS`;
 * the 10px send mark takes 44). This mark is bigger than either and still far
 * under the 150 the design authored for a mark large enough to show them.
 */
const TRIGGER_SEGMENTS = 60;

export interface EntityFabItem {
  /** Action ref or tab id. OPAQUE to the FAB — it never interprets this. */
  readonly id: string;
  readonly label: string;
  readonly glyph?: string;
  /** A count beside the label, e.g. Discussion's message count. 0 renders. */
  readonly count?: number;
  /**
   * Present ⇒ the row is REFUSED. It renders dimmed and non-activating, with
   * this string as its caption. It is NEVER omitted. See house rule 1.
   */
  readonly reason?: string;
  readonly onSelect?: () => void;
  /** `'end'` draws a hairline above the row — the Transfer / ⤢ lower group. */
  readonly group?: 'main' | 'end';
}

export interface EntityFabProps {
  readonly items: readonly EntityFabItem[];
  /** The trigger's accessible name, e.g. "Task actions". */
  readonly label: string;
  /** `'secondary'` stacks this FAB above the primary one — work_session's
      content-surface switch. Default `'primary'`. */
  readonly slot?: 'primary' | 'secondary';
  /** Trigger face. Default: the Möbius mark. A secondary FAB passes its own. */
  readonly face?: ReactNode;
  readonly testId?: string;
}

/**
 * The Möbius mark, at trigger size.
 *
 * `animated={false}`: this sits on screen for as long as the reader is on the
 * entity, and a mark that turns for a whole session burns a rAF forever while
 * asking the eye to track something that never resolves. `RibbonMark`'s own
 * comment says as much — turning is for a transient wait state.
 *
 * The ink is NOT set here. It is `--pn-ribbon-ink` on the button in
 * `entity-fab.css`, because a brand-inked mark on a brand-FILLED circle is its
 * own background; see the note there for which token and why the obvious one is
 * wrong.
 */
function TriggerMark() {
  return (
    <span className="efab__mark" aria-hidden>
      <RibbonMark className="efab__ribbon" animated={false} segments={TRIGGER_SEGMENTS} />
    </span>
  );
}

export function EntityFab({ items, label, slot = 'primary', face, testId }: EntityFabProps) {
  const { oneSurface } = useMobileSurface();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();

  /*
   * ONE CLOSE, FOR EVERY DISMISSAL ROUTE — the ✕, the scrim, Escape, and a row
   * that has just been selected. `MobileSheet` takes a single `onDismiss` for
   * the same reason: given one per gesture, a caller wires the button and leaves
   * Escape silently dead, and nothing fails.
   *
   * FOCUS RETURNS TO THE TRIGGER. The menu is the only thing that was focusable
   * while it was open; closing without moving focus leaves it on a detached node
   * and a keyboard reader lands back at the top of the document.
   */
  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  /*
   * Bound at the document and only while open, exactly as `MobileSheet` and
   * `MobileDrawer` bind theirs. A phone has no Escape key — this is here because
   * the phone shell is reachable on any coarse-pointer device, several of which
   * have keyboards, and because every other cover on this shell closes on it.
   *
   * Capture phase and `stopPropagation`, so one press does not ALSO close the
   * surface underneath: this menu is the topmost thing on screen while it is up.
   */
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, close]);

  /*
   * MAIN ROWS FIRST, END ROWS AFTER, order preserved inside each group.
   *
   * The hairline that separates the two groups is drawn by the FIRST end row
   * (`entity-fab.css`), so an end row that arrived in the middle of the list
   * would draw a divider across the middle of the stack. Partitioning here makes
   * the arrangement independent of the order a caller happens to build its list
   * in, rather than making that order a rule the caller has to know.
   */
  const rows = useMemo(
    () => [...items.filter((i) => i.group !== 'end'), ...items.filter((i) => i.group === 'end')],
    [items],
  );

  const activate = useCallback(
    (item: EntityFabItem) => {
      /* THE REFUSAL GUARD. A row carrying a reason does not act — it is dimmed,
         it keeps its reason, and it stays focusable so a keyboard reader can
         still learn WHY (the argument `DisabledWithReason` makes for using
         `aria-disabled` over the `disabled` attribute). */
      if (item.reason !== undefined) return;
      item.onSelect?.();
      close();
    },
    [close],
  );

  if (!oneSurface) return null;

  return (
    <div className={`efab${slot === 'secondary' ? ' efab--secondary' : ''}`} data-fab-slot={slot}>
      {open ? (
        <>
          {/* The scrim covers the frame beneath the menu and takes the tap that
              dismisses it. `aria-hidden` because it carries no meaning: the ✕ on
              the trigger is the announced way out. */}
          <div className="efab__scrim" aria-hidden onClick={close} />

          {/* TWO BOXES, AND THE INNER ONE IS THE SCROLLER. The outer is pinned
              between the header and the trigger and bottom-aligns its content;
              the inner takes the cap and the overflow. A single box that was
              both `justify-content: flex-end` and `overflow-y: auto` would put
              the rows that overflow ABOVE scroll position zero, where no scroll
              can reach them. */}
          <div className="efab__menu">
            <ul className="efab__list" id={menuId} role="menu" aria-label={label}>
              {rows.map((item) => (
                <FabRow key={item.id} item={item} onActivate={activate} />
              ))}
            </ul>
          </div>
        </>
      ) : null}

      <button
        ref={triggerRef}
        type="button"
        className="efab__trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-testid={testId ?? 'entity-fab'}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {open ? <span aria-hidden>✕</span> : (face ?? <TriggerMark />)}
      </button>
    </div>
  );
}

/**
 * ONE ROW. The pill is the control; the reason, when there is one, is a caption
 * BELOW it.
 *
 * That split is what lets a refusal keep its explanation without the pill
 * changing size — the shape `DisabledAction` already ships (`hon-disabled-group`
 * wrapping the control and its caption as siblings). A refusal that is a
 * different size from the live control it stands in for makes the stack jump as
 * an entity changes state, which `panel-bar-phone.css:220-227` states as a rule
 * for the panel bar and which is worse here, under a thumb. The stack is
 * bottom-anchored, so a caption's extra line grows AWAY from the trigger rather
 * than shifting the rows nearest it.
 */
function FabRow({
  item,
  onActivate,
}: {
  item: EntityFabItem;
  onActivate: (item: EntityFabItem) => void;
}) {
  const reasonId = useId();
  const refused = item.reason !== undefined;
  return (
    <li className={`efab__row${item.group === 'end' ? ' efab__row--end' : ''}`} role="none">
      <button
        type="button"
        role="menuitem"
        className="efab__item"
        data-fab-item={item.id}
        aria-disabled={refused || undefined}
        aria-describedby={refused ? reasonId : undefined}
        onClick={() => onActivate(item)}
      >
        {item.glyph ? (
          <span className="efab__glyph" aria-hidden>
            {item.glyph}
          </span>
        ) : null}
        <span className="efab__label">{item.label}</span>
        {/* `!== undefined`, not truthiness: a Discussion with no messages must
            read `0` rather than lose its counter, which is the absent-is-not-zero
            rule this codebase applies everywhere it counts something. */}
        {item.count !== undefined ? <span className="efab__count">{item.count}</span> : null}
      </button>
      {refused ? (
        <span className="efab__reason" id={reasonId}>
          {item.reason}
        </span>
      ) : null}
    </li>
  );
}
