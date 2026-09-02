/**
 * PanelResizer — the drag handle a side column hangs on, and the two hooks
 * that give it something to move.
 *
 * WHY THIS IS IN `kit/` RATHER THAN IN A SCREEN. The workspace grid already
 * shipped a resizable side column (`WorkspaceGrid`'s own handle), and the
 * entity detail screens shipped fixed 320/420 columns with a media query
 * stepping them down. That split is what the user reported: the same three
 * regions resize in one surface and refuse in another, which reads as a broken
 * control rather than as a missing one. One primitive, mounted by every screen
 * that has a side column, is what stops the two drifting apart again.
 *
 * THE FLOOR LAW STILL BINDS (02-LAYOUT §6 / geometry.ts's L4). Nothing here
 * invents a floor: every mount passes `minWidth`, and `maxWidth` is computed by
 * the SCREEN from a measurement, because only the screen knows what the centre
 * needs. A handle that could drag a column to zero would be a zero-floored
 * track by the back door.
 *
 * KEYBOARD IS NOT AN AFTERTHOUGHT. `role="separator"` with `aria-valuenow` is
 * the ARIA window-splitter pattern; arrows step, Home/End go to the bounds, and
 * double-click resets to the screen's default. A pointer-only resizer is a
 * control half the people using it cannot reach.
 *
 * BOTH AXES LIVE HERE, AND THAT IS THE SAME ARGUMENT AGAIN (owner, 2026-08-31:
 * Home's two panes must be able to sit side by side OR stacked, with the reader
 * choosing). A second component for the up/down gesture would be exactly the
 * drift this file's first paragraph exists to stop: two implementations of one
 * gesture, and the clamping, the drag origin, the keyboard contract and the
 * disabled-separator ARIA reading would then have to be got right twice. So
 * `side` grew two more values rather than the module growing a twin:
 *
 *     left  · the panel is LEFT of the handle   — drag right to grow  (x axis)
 *     right · the panel is RIGHT of the handle  — drag left to grow   (x axis)
 *     top   · the panel is ABOVE the handle     — drag down to grow   (y axis)
 *     bottom· the panel is BELOW the handle     — drag up to grow     (y axis)
 *
 * Everything the two axes share — the floor law, reset on double-click and on
 * Backspace/Delete, the 8px hit target painting a 1px hairline, `aria-controls`
 * naming the element that actually moves — is written once and reads the axis
 * only where the axis genuinely differs: which coordinate the drag measures,
 * which arrow keys step, and which way `aria-orientation` points.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';

/** Which side of the handle the panel it controls sits on. */
export type ResizerSide = 'left' | 'right' | 'top' | 'bottom';

/** The axis a handle MOVES ALONG. `left`/`right` slide horizontally and paint a
 *  vertical hairline; `top`/`bottom` slide vertically and paint a horizontal
 *  one. Note the inversion — a `separator` whose own orientation is horizontal
 *  is the one that moves up and down, which is why `aria-orientation` below
 *  reads the opposite word to the axis name. */
export function resizerAxis(side: ResizerSide): 'x' | 'y' {
  return side === 'left' || side === 'right' ? 'x' : 'y';
}

/** One arrow press. Matches the workspace grid's step so the two feel alike. */
export const RESIZE_STEP = 16;

export interface PanelResizerProps {
  /** `left` ⇒ the panel is to the LEFT of this handle; dragging right widens it.
   *  `top` ⇒ the panel is ABOVE it; dragging down makes it taller. */
  side: ResizerSide;
  /** Names the panel in the accessible label — "Resize Tasks list panel". */
  label: string;
  /**
   * The panel's CURRENT applied extent ALONG THE AXIS THIS HANDLE MOVES — its
   * width for `left`/`right`, its HEIGHT for `top`/`bottom`. The three numbers
   * kept the `width` names when the y axis arrived: five mounts pass them, a
   * rename to `size` would touch every one of those files and buy nothing this
   * sentence does not already say, and `aria-valuenow` is axis-agnostic anyway.
   */
  width: number;
  minWidth: number;
  /** Computed by the caller from a measurement — see the docblock. */
  maxWidth: number;
  /** `id` of the element this separator controls, for `aria-controls`. */
  controls?: string;
  /** A collapsed or stacked column has nothing to resize; the handle stays but refuses. */
  disabled?: boolean;
  onResize(width: number): void;
  /** Double-click / Backspace — back to the screen's default width. */
  onReset?(): void;
  /**
   * A DRAG THAT ASKS FOR LESS THAN THE FLOOR — the collapse gesture, optional.
   *
   * WITHOUT THIS THE FLOOR LAW AND THE COLLAPSE GESTURE CONTRADICT EACH OTHER.
   * `onResize` only ever sees CLAMPED values, by design: this component may not
   * hand a screen a width below the floor it declared. So a caller that wants
   * "keep dragging past the floor and the panel closes" — the standard splitter
   * behaviour, and what Home's ACTIVE pane does at band 3 — has no way to tell
   * a drag resting ON the floor from one straining well past it. The first
   * attempt at Home was to lower `minWidth` and collapse inside `onResize`,
   * which makes `aria-valuemin` announce a width the panel never actually
   * takes: a lie in the one place a screen-reader user has to trust.
   *
   * So the RAW request is reported here instead, and only when it is
   * meaningfully past the floor (`COLLAPSE_SLACK`) — a jittery pointer resting
   * at the floor must not close a panel out from under a reader.
   *
   * ABSENT ⇒ NOTHING NEW HAPPENS. The four mounts that predate this pass none,
   * and for them the floor still simply clamps, which is what their screens
   * want: an entity detail column that vanished mid-drag would be a surprise,
   * not a feature. A collapse needs a way back drawn on screen (ruling 3,
   * 2026-08-16), and only a caller that has drawn one may ask for this.
   */
  onBeyondFloor?(): void;
}

/** How far past the floor a drag has to reach before it means "close it".
 *  One arrow step and a half: further than a hand shake, nearer than a shove. */
export const COLLAPSE_SLACK = 24;

export function PanelResizer(props: PanelResizerProps) {
  const {
    side,
    label,
    width,
    minWidth,
    maxWidth,
    controls,
    disabled = false,
    onResize,
    onReset,
    onBeyondFloor,
  } = props;
  const drag = useRef<{ pointerId: number; origin: number; width: number; maxWidth: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  const interactive = !disabled;
  const axis = resizerAxis(side);
  /** The coordinate this handle travels along. One expression, so a drag can
   *  never measure the axis it does not move on. */
  const coordinate = (event: PointerEvent<HTMLDivElement>) =>
    axis === 'x' ? event.clientX : event.clientY;
  /** `left`/`top` grow when the pointer moves in the POSITIVE direction (right,
   *  down); `right`/`bottom` grow when it moves the other way. */
  const grows = side === 'left' || side === 'top';

  const clamp = (next: number, maximum = maxWidth) =>
    Math.min(Math.max(minWidth, next), Math.max(minWidth, maximum));

  /* A drag right is a WIDENING for a left panel and a NARROWING for a right
     one — and a drag DOWN is a heightening for a top panel and a shortening for
     a bottom one. Folding the sign in here is what lets all four mounts pass
     the same numbers and get the gesture they expect. */
  const applyMovement = (movement: number, from: number, maximum: number) => {
    const requested = from + (grows ? movement : -movement);
    /* The RAW request is read before the clamp, and only for the collapse
       report — `onResize` still never sees an unfloored number. */
    if (onBeyondFloor && requested < minWidth - COLLAPSE_SLACK) {
      onBeyondFloor();
      return;
    }
    onResize(clamp(requested, maximum));
  };

  const stopResize = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    drag.current = null;
    setResizing(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  return (
    <div
      className="kit-resizer"
      role="separator"
      aria-label={`Resize ${label} panel`}
      /* THE WORD IS THE SEPARATOR'S OWN ORIENTATION, NOT THE DRAG'S. A handle
         that slides left/right is a VERTICAL rule between two columns; one that
         slides up/down is a HORIZONTAL rule between two rows. Reading it the
         other way round is the single most common mistake in this pattern and
         it announces every splitter as the wrong shape. */
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-controls={controls}
      /*
       * THE RANGE EXISTS ONLY WHILE THE SEPARATOR IS A CONTROL.
       *
       * Disabled, the caller has no obligation to keep `width` inside
       * [min, max] — and `EntityView` genuinely does not: a collapsed list rail
       * is 34px wide against a 220px floor, so publishing the range anyway
       * announced `valuenow=34, valuemin=220`, a value outside its own bounds.
       * ARIA has no reading for that, and "34" is not even the number a
       * screen-reader user wants: the rail is not 34px narrow, it is CLOSED.
       *
       * A `role="separator"` without `aria-valuenow` is the spec's own static
       * divider — exactly what a non-resizable divider IS — so dropping the
       * three attributes states the truth rather than a contradiction. The
       * element stays in the tree and stays visible on purpose: it is the
       * pointer target that must not move out from under a cursor.
       * (Reported by review of PR #213.)
       */
      aria-valuemin={interactive ? Math.round(minWidth) : undefined}
      aria-valuemax={interactive ? Math.round(Math.max(minWidth, maxWidth)) : undefined}
      aria-valuenow={interactive ? Math.round(width) : undefined}
      aria-disabled={!interactive || undefined}
      tabIndex={interactive ? 0 : -1}
      data-side={side}
      data-resizing={resizing || undefined}
      data-testid={`panel-resizer-${side}`}
      onDoubleClick={() => {
        if (interactive) onReset?.();
      }}
      onPointerDown={(event) => {
        if (!interactive || event.button !== 0) return;
        event.preventDefault();
        drag.current = { pointerId: event.pointerId, origin: coordinate(event), width, maxWidth };
        setResizing(true);
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start || start.pointerId !== event.pointerId) return;
        applyMovement(coordinate(event) - start.origin, start.width, start.maxWidth);
      }}
      onPointerUp={stopResize}
      onPointerCancel={stopResize}
      onKeyDown={(event) => {
        if (!interactive) return;
        if (event.key === 'Home') {
          event.preventDefault();
          onResize(minWidth);
          return;
        }
        if (event.key === 'End') {
          event.preventDefault();
          onResize(Math.max(minWidth, maxWidth));
          return;
        }
        if (event.key === 'Backspace' || event.key === 'Delete') {
          if (!onReset) return;
          event.preventDefault();
          onReset();
          return;
        }
        /* THE ARROWS FOLLOW THE AXIS. A handle that moves up and down and
           answers to ArrowLeft is a keyboard path that contradicts the pointer
           one; the ARIA splitter pattern binds the arrows of the axis the
           separator travels, and nothing else. */
        const back = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
        const forward = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
        if (event.key !== back && event.key !== forward) return;
        event.preventDefault();
        applyMovement(event.key === back ? -RESIZE_STEP : RESIZE_STEP, width, maxWidth);
      }}
    >
      <span className="kit-resizer__line" aria-hidden />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Persistence — a width the viewer set is a preference, not session state
// ---------------------------------------------------------------------------

/**
 * Viewer-local, keyed by the panel. A column width is a reading preference and
 * it follows the person across spaces, exactly as the theme does; scoping it
 * per space would ask the same question again in every space.
 */
const WIDTH_PREFIX = 'tm8ui.panel-width.';
/**
 * THE HEIGHT IS A DIFFERENT NUMBER UNDER THE SAME NAME, so it gets its own
 * prefix rather than sharing the width's.
 *
 * A splitter that can be flipped between side-by-side and stacked (Home,
 * 2026-08-31) asks the same key — `home.side` — for two extents that have
 * nothing to do with each other: 420px is a reasonable width for that pane and
 * a preposterous height for it, and 200px is the reverse. One slot per key
 * would hand the stacked arrangement the number the reader chose for the
 * side-by-side one, and then OVERWRITE it on the first drag — the exact
 * failure `useKeyedState` was written for, one axis over.
 */
const HEIGHT_PREFIX = 'tm8ui.panel-height.';
const FLAG_PREFIX = 'tm8ui.panel-flag.';
const CHOICE_PREFIX = 'tm8ui.panel-choice.';

function readNumber(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    // Private mode / blocked storage. The column still resizes, it just
    // cannot remember — never let a storage refusal take a screen down.
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // As above: the change applies now even when it cannot be persisted.
  }
}

export interface PanelWidth {
  /** The viewer's stored preference, floored — NOT clamped to the viewport. */
  width: number;
  setWidth(next: number): void;
  reset(): void;
}

/** The y-axis twin. Same three members, named for the axis they hold, so a
 *  caller cannot pass a height where a width is expected without saying so. */
export interface PanelHeight {
  /** The viewer's stored preference, floored — NOT clamped to the viewport. */
  height: number;
  setHeight(next: number): void;
  reset(): void;
}

/**
 * THE KEY CAN CHANGE UNDER A LIVE HOOK, AND THAT IS THE HARD PART.
 *
 * A `useState` initializer runs ONCE per mount. `EntityView` keys these hooks
 * by kind (`entity.task.list`, `entity.doc.list`) and the shell switches kinds
 * by changing a PROP on a component it keeps mounted — so a Tasks→Docs switch
 * moves the key without remounting anything. Read-on-mount alone therefore
 * serves Docs whatever Tasks had, and the first resize afterwards WRITES that
 * inherited number under the Docs key: the preference does not just display
 * wrong, it is overwritten. (Reported by review of PR #213; reproduced with
 * stored Tasks 500 / Docs 260 coming back as 500 for Docs.)
 *
 * The fix is the standard adjust-state-during-render pattern rather than an
 * effect: the value used for THIS render is re-read immediately, so the stale
 * width is never painted. An effect would paint the previous kind's width for
 * one frame — which is exactly the flash the width solver exists to avoid.
 */
function useKeyedState<T>(storageKey: string, load: (key: string) => T): [T, (next: T) => void] {
  const [entry, setEntry] = useState<{ key: string; value: T }>(() => ({
    key: storageKey,
    value: load(storageKey),
  }));
  const current = entry.key === storageKey ? entry : { key: storageKey, value: load(storageKey) };
  if (entry.key !== storageKey) setEntry(current);
  const set = useCallback((next: T) => setEntry({ key: storageKey, value: next }), [storageKey]);
  return [current.value, set];
}

/**
 * The stored width is deliberately NOT clamped to the current viewport here.
 *
 * Clamping on write is how a preference dies: narrow the window once, and the
 * 520px the viewer chose is overwritten with the 240px that happened to fit.
 * The SCREEN clamps for paint (it is the one holding the measurement); this
 * hook holds what was asked for, so widening the window restores it.
 */
function useStoredExtent(
  prefix: string,
  key: string,
  fallback: number,
  minimum: number,
): { value: number; set(next: number): void; reset(): void } {
  const storageKey = `${prefix}${key}`;
  const load = useCallback(
    (target: string) => {
      if (typeof window === 'undefined') return fallback;
      const stored = readNumber(target);
      return stored === null ? fallback : Math.max(minimum, stored);
    },
    [fallback, minimum],
  );
  const [value, setState] = useKeyedState<number>(storageKey, load);

  const set = useCallback(
    (next: number) => {
      const floored = Math.max(minimum, Math.round(next));
      setState(floored);
      write(storageKey, String(floored));
    },
    [storageKey, minimum, setState],
  );

  const reset = useCallback(() => {
    setState(fallback);
    write(storageKey, String(fallback));
  }, [storageKey, fallback, setState]);

  return { value, set, reset };
}

export function usePanelWidth(key: string, fallback: number, minWidth: number): PanelWidth {
  const { value, set, reset } = useStoredExtent(WIDTH_PREFIX, key, fallback, minWidth);
  return { width: value, setWidth: set, reset };
}

/**
 * THE HEIGHT EQUIVALENT — same storage, same key-awareness, its own slot.
 *
 * Every sentence of `usePanelWidth`'s docblock above applies here verbatim,
 * which is why the body is shared rather than copied: the no-clamp-on-write
 * law, the read-on-key-change adjustment, and the storage refusal that must
 * never take a screen down are ONE implementation, and a defect fixed in it is
 * fixed on both axes at once. The only difference between the two exports is
 * which prefix they address and what they call the number.
 */
export function usePanelHeight(key: string, fallback: number, minHeight: number): PanelHeight {
  const { value, set, reset } = useStoredExtent(HEIGHT_PREFIX, key, fallback, minHeight);
  return { height: value, setHeight: set, reset };
}

/**
 * A persisted boolean — "is this column collapsed", "is the rail collapsed".
 *
 * The setter takes an updater as well as a value, because every caller that
 * owns a TOGGLE writes `set((open) => !open)`; a value-only setter would make
 * each of them read the current state through a closure, which is how a toggle
 * bound to a keyboard shortcut ends up one press behind.
 */
export function usePanelFlag(
  key: string,
  fallback: boolean,
): [boolean, (next: boolean | ((current: boolean) => boolean)) => void] {
  const storageKey = `${FLAG_PREFIX}${key}`;
  /* Key-aware for the same reason `usePanelWidth` is — see `useKeyedState`.
     The collapse flag is keyed per kind too, so read-on-mount alone let a
     collapsed Tasks rail collapse Docs and then persist it there. */
  const load = useCallback(
    (target: string) => {
      if (typeof window === 'undefined') return fallback;
      try {
        const raw = window.localStorage.getItem(target);
        return raw === null ? fallback : raw === '1';
      } catch {
        return fallback;
      }
    },
    [fallback],
  );
  const [flag, setState] = useKeyedState<boolean>(storageKey, load);

  /* The updater is resolved against a REF rather than inside `setState`'s own
     updater, because that updater must stay pure — React may call it twice —
     and writing to storage from it would do the write twice. The ref also
     makes two toggles in one frame land correctly.

     It is assigned from `flag`, which `useKeyedState` has already re-read for
     the CURRENT key — so a toggle immediately after a kind switch flips the new
     kind's value, not the departed kind's. */
  const latest = useRef(flag);
  latest.current = flag;

  const set = useCallback(
    (next: boolean | ((current: boolean) => boolean)) => {
      const resolved = typeof next === 'function' ? next(latest.current) : next;
      latest.current = resolved;
      setState(resolved);
      write(storageKey, resolved ? '1' : '0');
    },
    [storageKey, setState],
  );

  return [flag, set];
}

/**
 * A persisted CHOICE FROM A CLOSED SET — "which category tab is open on this
 * kind's list". The third shape beside `usePanelWidth` and `usePanelFlag`, and
 * keyed the same way, because it fails the same way when it is not: the list
 * panel swaps `kind` on a mounted component, so a read-on-mount hook would
 * serve Tasks' tab to Docs and then persist it there (see `useKeyedState`).
 *
 * `valid` is REQUIRED, not an optional courtesy. What comes back out of
 * storage is a string written by some earlier build, and the caller is the
 * only one that knows this key's current vocabulary; an id that is no longer
 * offered must read as "nothing remembered" and fall to the caller's default,
 * never be handed back as a selection no control can show.
 */
export function usePanelChoice(
  key: string,
  fallback: string,
  valid: (candidate: string) => boolean,
): [string, (next: string) => void] {
  const storageKey = `${CHOICE_PREFIX}${key}`;
  /* `valid` is a fresh closure on most renders, so it is read through a ref
     rather than closed over by `load` — otherwise `useKeyedState`'s memo of
     `load` would change identity every render and re-read storage each time.
     The ref always holds this render's predicate, which is the one that
     matters: `load` only ever runs during a render. */
  const validRef = useRef(valid);
  validRef.current = valid;
  const load = useCallback(
    (target: string) => {
      if (typeof window === 'undefined') return fallback;
      try {
        const raw = window.localStorage.getItem(target);
        return raw !== null && validRef.current(raw) ? raw : fallback;
      } catch {
        return fallback;
      }
    },
    [fallback],
  );
  const [stored, setState] = useKeyedState<string>(storageKey, load);
  /* The stored value can also go stale WITHOUT the key changing — a build that
     retires a tab id leaves it sitting in state from a load that accepted it.
     Re-checking on read costs one predicate call and keeps the invariant
     ("what this hook returns is always in the current vocabulary") true for
     every render rather than only the first after a key change. */
  const choice = valid(stored) ? stored : fallback;

  const set = useCallback(
    (next: string) => {
      setState(next);
      write(storageKey, next);
    },
    [storageKey, setState],
  );

  return [choice, set];
}

// ---------------------------------------------------------------------------
// Measurement — because `maxWidth` must be measured, never assumed
// ---------------------------------------------------------------------------

/**
 * The element's content width, observed.
 *
 * A screen cannot compute an honest `maxWidth` from a media-query breakpoint:
 * the shell's own rail and the workspace's panels are both variable, so the
 * width available to a detail screen is not a function of the window. The same
 * rule the geometry solver states — breakpoints are DERIVED by measurement —
 * applies one level down, which is why this returns 0 until it has actually
 * measured something rather than guessing a first frame.
 */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  return useElementExtent(ref, 'width');
}

/**
 * The element's content HEIGHT, observed — the y-axis twin, and needed for the
 * same reason: a stacked splitter's ceiling is "what the row can spare once the
 * lower pane's floor is paid", and only a measurement knows how tall the row
 * actually is. A `vh` unit would answer for the WINDOW, which is not the same
 * thing once a top bar, a trail strip and a gutter have been spent.
 */
export function useElementHeight(ref: RefObject<HTMLElement | null>): number {
  return useElementExtent(ref, 'height');
}

function useElementExtent(ref: RefObject<HTMLElement | null>, axis: 'width' | 'height'): number {
  const [extent, setExtent] = useState(0);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // jsdom and older engines have no ResizeObserver; the fallback is one
    // measurement, which is honest — it just does not follow later resizes.
    if (typeof ResizeObserver === 'undefined') {
      setExtent(node.getBoundingClientRect()[axis]);
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setExtent(entry.contentRect[axis]);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, axis]);

  return extent;
}
