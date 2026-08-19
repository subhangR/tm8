/**
 * THE SHEET — the phone's answer to the desktop's THIRD COLUMN.
 *
 * `MobileFrame` has always had a sheet region and nothing has ever filled it.
 * This fills it, and it is deliberately built as a REUSABLE PRIMITIVE rather
 * than as the aux column's private trick: Lane 3 applies this to seven more
 * destinations, and seven bespoke sheets would be seven chances to disagree
 * about what dismiss means.
 *
 * ── WHAT A SHEET IS FOR ────────────────────────────────────────────────────
 *
 * On the desktop, a detail that references another entity opens it BESIDE the
 * document (`.ev-aux`) — the whole point of the third column is that you do not
 * lose your place. A phone has one surface, so "beside" is not available. The
 * sheet is the same promise kept differently: the thing you were reading stays
 * mounted underneath, and the reference covers it TEMPORARILY.
 *
 * That is why a sheet is not a pushed screen. A push replaces your place; a
 * sheet suspends it. Pushing the aux would put a referenced entity into the
 * back stack, and backing out of it would then walk the screen stack rather
 * than returning you to the paragraph you tapped from.
 *
 * ── WHY A PORTAL, AND NOT A STORE ──────────────────────────────────────────
 *
 * The obvious build is a module-level store the way `screenStackStore` is one:
 * `present(node)` / `dismiss()`. It is wrong here for a specific reason —
 * a sheet's content closes over the state of the screen that opened it, and a
 * `ReactNode` pushed into a store is a SNAPSHOT. It would keep rendering the
 * props it was built with while the screen underneath moved on, and the failure
 * is a stale sheet showing an entity's old title: quiet, plausible, and hard to
 * attribute.
 *
 * Rendered as a portal, the sheet stays in its owner's render tree. It re-renders
 * when its owner does, reads live props, and unmounts when its owner stops
 * rendering it — so `dismiss` is just the owner setting its own state, and there
 * is no second lifecycle to keep in sync. The DOM position comes from the frame
 * (which knows where the tab bar is); the content and its lifetime come from the
 * screen (which knows what it is showing). Each fact stays with its owner.
 *
 * ── INERT OFF THE PHONE, BY CONSTRUCTION ───────────────────────────────────
 *
 * `sheetHost` is null wherever there is no phone frame, and this returns null
 * there. So a shared screen may render `<MobileSheet>` UNCONDITIONALLY beside
 * its desktop column and the desktop is untouched — which is what keeps a
 * screen from needing two divergent copies of its own body.
 */
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useMobileSurface } from './surface';

export interface MobileSheetProps {
  /**
   * The sheet's own name, in the header and as its accessible name. A sheet
   * covers the screen that opened it, so it has to say what it is — an
   * unlabelled cover is indistinguishable from the app having navigated.
   */
  readonly title: ReactNode;

  /**
   * Called for every dismissal route — the ✕, the backdrop, Escape. ONE
   * callback rather than one per gesture, so a host cannot wire the button and
   * silently leave Escape doing nothing.
   */
  readonly onDismiss: () => void;

  readonly children: ReactNode;

  /**
   * HOW MUCH OF THE FRAME THE SHEET TAKES.
   *
   * `'default'` is the 72%/88% sheet described above: it stops short of the top
   * so a strip of the screen underneath stays visible, and that strip is what
   * says "this is over your place, not instead of it".
   *
   * `'full'` gives that strip up, and only a surface that needs the room should
   * ask for it. The case it exists for is a COMPOSER: the frame is already
   * `100dvh` minus the measured keyboard inset, so with the keyboard up an 88%
   * sheet is 88% of what is left — a composer, its foot row and two visible
   * messages. A surface with nothing to type into has no such pressure and
   * should keep the strip.
   *
   * It reaches the stylesheet as an ATTRIBUTE on the panel rather than as an
   * inline height, so the sizes stay beside each other in one rule and a test
   * can read the choice back without a layout engine — jsdom loads no
   * stylesheets, so the attribute is the only part of this a vitest can see.
   */
  readonly size?: 'default' | 'full';

  /** Marks the sheet element, so a test can find one host's sheet specifically. */
  readonly testId?: string;
}

export function MobileSheet({ title, onDismiss, children, size = 'default', testId }: MobileSheetProps) {
  const { sheetHost } = useMobileSurface();

  /*
   * The live callback, so the key handler below can be bound ONCE.
   *
   * `onDismiss` is nearly always an arrow built in the host's render, so a new
   * identity arrives every frame. In the effect's dependency list that would
   * tear down and re-add a document listener on every render of the screen
   * underneath — and a listener that is absent for an instant on each pass is a
   * dismiss that occasionally does not happen, which reads as a flaky sheet
   * rather than as a dependency bug.
   */
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  /*
   * ESCAPE, BOUND AT THE DOCUMENT.
   *
   * A phone has no Escape key, so this is not the phone's dismissal gesture —
   * the ✕ and the backdrop are. It is here because the phone shell is reachable
   * on any coarse-pointer device, several of which have keyboards, and because
   * the desktop's aux column has always closed on Escape. A surface that
   * replaces that column and drops the gesture is a regression for anyone who
   * had learnt it.
   */
  useEffect(() => {
    if (!sheetHost) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      /* The sheet is the topmost surface while it is open, so it takes the key
         before anything under it can — otherwise Escape would ALSO close the
         detail behind the sheet, and one press would undo two things. */
      e.stopPropagation();
      dismissRef.current();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [sheetHost]);

  /*
   * A tap on the backdrop dismisses; a tap INSIDE the panel must not.
   *
   * Checking the event target against `currentTarget` rather than stopping
   * propagation on the panel: `stopPropagation` on the panel would also swallow
   * events the content legitimately bubbles (a menu closing on an outside
   * click), and that failure would appear inside the sheet's content rather
   * than here, where nobody would look for it.
   */
  const onBackdrop = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onDismiss();
    },
    [onDismiss],
  );

  if (!sheetHost) return null;

  return createPortal(
    <div className="msheet" onClick={onBackdrop} data-testid={testId ?? 'mobile-sheet'}>
      {/* `aria-modal` is a CLAIM, and it is true here: the backdrop covers the
          frame, including the tab bar, so nothing behind it is reachable by a
          tap. It would be a lie on a sheet that stopped short of the chrome. */}
      <div
        className="msheet__panel"
        data-size={size}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
      >
        <div className="msheet__head">
          {/* The grabber is decorative — it is the affordance that says "this
              slides", drawn for the eye. The ✕ beside it is the real control,
              because a drag-to-dismiss this does not implement must not be the
              ONLY way out. */}
          <span className="msheet__grip" aria-hidden="true" />
          <span className="msheet__title">{title}</span>
          <button type="button" className="msheet__close" aria-label="Close sheet" onClick={onDismiss}>
            ✕
          </button>
        </div>
        <div className="msheet__body">{children}</div>
      </div>
    </div>,
    sheetHost,
  );
}
