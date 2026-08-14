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
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';

/** Which side of the handle the panel it controls sits on. */
export type ResizerSide = 'left' | 'right';

/** One arrow press. Matches the workspace grid's step so the two feel alike. */
export const RESIZE_STEP = 16;

export interface PanelResizerProps {
  /** `left` ⇒ the panel is to the LEFT of this handle; dragging right widens it. */
  side: ResizerSide;
  /** Names the panel in the accessible label — "Resize Tasks list panel". */
  label: string;
  /** The panel's CURRENT applied width, in px. */
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
}

export function PanelResizer(props: PanelResizerProps) {
  const { side, label, width, minWidth, maxWidth, controls, disabled = false, onResize, onReset } = props;
  const drag = useRef<{ pointerId: number; x: number; width: number; maxWidth: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  const interactive = !disabled;

  const clamp = (next: number, maximum = maxWidth) =>
    Math.min(Math.max(minWidth, next), Math.max(minWidth, maximum));

  /* A drag right is a WIDENING for a left panel and a NARROWING for a right
     one. Folding the sign in here is what lets both mounts pass the same
     numbers and get the gesture they expect. */
  const applyMovement = (movement: number, from: number, maximum: number) => {
    onResize(clamp(from + (side === 'left' ? movement : -movement), maximum));
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
      aria-orientation="vertical"
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
        drag.current = { pointerId: event.pointerId, x: event.clientX, width, maxWidth };
        setResizing(true);
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start || start.pointerId !== event.pointerId) return;
        applyMovement(event.clientX - start.x, start.width, start.maxWidth);
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
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        applyMovement(event.key === 'ArrowLeft' ? -RESIZE_STEP : RESIZE_STEP, width, maxWidth);
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
const FLAG_PREFIX = 'tm8ui.panel-flag.';

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
export function usePanelWidth(key: string, fallback: number, minWidth: number): PanelWidth {
  const storageKey = `${WIDTH_PREFIX}${key}`;
  const load = useCallback(
    (target: string) => {
      if (typeof window === 'undefined') return fallback;
      const stored = readNumber(target);
      return stored === null ? fallback : Math.max(minWidth, stored);
    },
    [fallback, minWidth],
  );
  const [width, setState] = useKeyedState<number>(storageKey, load);

  const setWidth = useCallback(
    (next: number) => {
      const floored = Math.max(minWidth, Math.round(next));
      setState(floored);
      write(storageKey, String(floored));
    },
    [storageKey, minWidth, setState],
  );

  const reset = useCallback(() => {
    setState(fallback);
    write(storageKey, String(fallback));
  }, [storageKey, fallback, setState]);

  return { width, setWidth, reset };
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
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // jsdom and older engines have no ResizeObserver; the fallback is one
    // measurement, which is honest — it just does not follow later resizes.
    if (typeof ResizeObserver === 'undefined') {
      setWidth(node.getBoundingClientRect().width);
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}
