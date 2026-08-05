import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { WorkSessionInteractionProfileProjection } from '@tm8/contract';
import type { ContentSurface } from '../../routes';

const PREFERENCE_PREFIX = 'tm8:work-session-surface:v1';
/**
 * SPLIT is viewer-local layout, deliberately NOT a fourth `ContentSurface`.
 *
 * `ContentSurface` is a contract type (`@tm8/contract`), projected and stored
 * server-side as `initialContentSurface`. A layout preference is not a surface:
 * nothing on the server needs to know two panes are visible at once, and
 * widening a stored contract enum to carry a CSS arrangement would make every
 * consumer of that enum handle a value that means nothing to it. So Split rides
 * its own local key and the route keeps naming the surface that owns focus.
 */
const SPLIT_PREFIX = 'tm8:work-session-split:v1';
const RATIO_PREFIX = 'tm8:work-session-split-ratio:v1';
/** Neither pane may be driven below this share of the width. */
const MIN_RATIO = 0.2;
const MAX_RATIO = 0.8;
const DEFAULT_RATIO = 0.5;

const SURFACE_LABEL: Readonly<Record<ContentSurface, string>> = {
  terminal: 'Terminal',
  chat: 'Chat',
  debug: 'Debug',
};

export interface WorkSessionContentProps {
  sessionId: string;
  viewerMemberId?: string | null;
  profile?: WorkSessionInteractionProfileProjection | null;
  /** Explicit route selection. It outranks the viewer-local preference. */
  requestedSurface?: ContentSurface | null;
  terminal: ReactNode;
  chat: ReactNode;
  /**
   * The DEBUG surface (the session's CLI journal). Always offered — it does not
   * depend on the immutable chat pin — so the switch shows a Debug chip whether
   * or not Chat exists. Rendered ONLY while selected so its poll stops the
   * moment the viewer leaves it (the "poll only while selected" half of the
   * honesty rule); the terminal, by contrast, stays mounted throughout.
   */
  debug?: ReactNode;
  onSurfaceChange?: (surface: ContentSurface) => void;
  /**
   * USER RULING 2026-07-31 — "the terminal, chat tab should be at the top row
   * at the right with two switchable chips."
   *
   * The switch used to own a 52px row of its own directly above the canvas.
   * That row bought nothing the panel bar could not hold, and it cost the
   * primary surface height on every single session — the same economy R5 #10
   * already ruled on for the context header.
   *
   * When the panel hands us its bar's slot node, the switch renders THERE via
   * a portal instead of inline. A portal rather than lifting the state up
   * because this component, not the panel, owns the route/preference/clamp
   * logic; moving that out to satisfy DOM order would spread one decision
   * across two files. The target always lives inside the same `.cv2-root`
   * subtree, so the ambient theme and zoom scope are unchanged.
   *
   * Null (the default) keeps the old inline row — that is what the standalone
   * tests and any host without a bar still render.
   */
  switchSlot?: HTMLElement | null;
}

/**
 * The work-session Content switch owns presentation only. The immutable pin
 * decides whether Chat exists; DEBUG always exists; the launch provider/model
 * never enters this component. Terminal (and Chat, once shown) stay mounted
 * after render so xterm and its PTY transport keep exactly the same component
 * instance while another surface is visible.
 */
export function WorkSessionContent({
  sessionId,
  viewerMemberId,
  profile,
  requestedSurface = null,
  terminal,
  chat,
  debug,
  onSurfaceChange,
  switchSlot = null,
}: WorkSessionContentProps) {
  const chatAvailable = profile?.chatEnabled === true;
  // The offered surfaces, in fixed order. Terminal is always first (and the
  // default); Chat is gated by the immutable pin; Debug is always last.
  const surfaces = useMemo<ContentSurface[]>(
    () => ['terminal', ...(chatAvailable ? (['chat'] as const) : []), 'debug'],
    [chatAvailable],
  );
  const preferenceKey = `${PREFERENCE_PREFIX}:${viewerMemberId ?? 'anonymous'}:${sessionId}`;
  const [surface, setSurface] = useState<ContentSurface>(() =>
    resolveInitialSurface({ requestedSurface, chatAvailable, preferenceKey }),
  );
  const [chatMounted, setChatMounted] = useState(() =>
    resolveInitialSurface({ requestedSurface, chatAvailable, preferenceKey }) === 'chat',
  );
  const previousRequest = useRef(requestedSurface);
  const tabRefs = useRef<Partial<Record<ContentSurface, HTMLButtonElement | null>>>({});
  const id = useId();

  const splitKey = `${SPLIT_PREFIX}:${viewerMemberId ?? 'anonymous'}:${sessionId}`;
  const ratioKey = `${RATIO_PREFIX}:${viewerMemberId ?? 'anonymous'}`;
  const [splitRequested, setSplitRequested] = useState(() => readFlag(splitKey));
  const [ratio, setRatio] = useState(() => readRatio(ratioKey));
  const splitRef = useRef<HTMLDivElement | null>(null);

  // Split needs BOTH panes, so it is only ever honoured while Chat exists and
  // Debug — which owns the whole canvas and unmounts when deselected — is not
  // the selected surface. Everywhere else this stays a plain tab switch.
  const splitting = splitRequested && chatAvailable && surface !== 'debug';

  // Entering Split mounts Chat for the same reason selecting it does: the pane
  // is about to be visible, and `chatMounted` is what keeps it alive after.
  useEffect(() => {
    if (splitting) setChatMounted(true);
  }, [splitting]);

  const toggleSplit = useCallback(() => {
    setSplitRequested((on) => {
      const next = !on;
      writeLocal(splitKey, next ? 'on' : 'off');
      return next;
    });
  }, [splitKey]);

  // Pointer-driven resize. The ratio is committed to storage on release rather
  // than on every move: a drag is one decision, not sixty writes.
  const onDividerPointerDown = useCallback(
    (event: { clientX: number; currentTarget: Element; pointerId: number }) => {
      const host = splitRef.current;
      if (!host) return;
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
      const move = (moveEvent: PointerEvent) => {
        const box = host.getBoundingClientRect();
        if (box.width <= 0) return;
        setRatio(clampRatio((moveEvent.clientX - box.left) / box.width));
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        setRatio((committed) => {
          writeLocal(ratioKey, String(committed));
          return committed;
        });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [ratioKey],
  );

  // The divider is a real separator: arrow keys move it, Home/End slam it to
  // the clamps, so a split is reachable without a pointer.
  const onDividerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 0.1 : 0.02;
      let next: number | null = null;
      if (event.key === 'ArrowLeft') next = ratio - step;
      else if (event.key === 'ArrowRight') next = ratio + step;
      else if (event.key === 'Home') next = MIN_RATIO;
      else if (event.key === 'End') next = MAX_RATIO;
      else if (event.key === 'Enter') next = DEFAULT_RATIO;
      if (next === null) return;
      event.preventDefault();
      const clamped = clampRatio(next);
      setRatio(clamped);
      writeLocal(ratioKey, String(clamped));
    },
    [ratio, ratioKey],
  );

  // External route hydration remains authoritative. A missing route value is
  // not treated as a change after mount, otherwise every local tab click would
  // immediately snap back to the pinned default before the router can mirror.
  useEffect(() => {
    if (previousRequest.current === requestedSurface) return;
    previousRequest.current = requestedSurface;
    if (requestedSurface === 'chat' && !chatAvailable) {
      setSurface('terminal');
      return;
    }
    if (requestedSurface) {
      if (requestedSurface === 'chat') setChatMounted(true);
      setSurface(requestedSurface);
    }
  }, [chatAvailable, requestedSurface]);

  // A fresh projection may revoke Chat while the panel stays mounted. Clamp
  // the rendering immediately; never leave an unavailable pane selected.
  useEffect(() => {
    if (!chatAvailable && surface === 'chat') setSurface('terminal');
  }, [chatAvailable, surface]);

  const select = useCallback(
    (next: ContentSurface, focus = false) => {
      if (next === 'chat' && !chatAvailable) return;
      if (next === 'chat') setChatMounted(true);
      setSurface(next);
      writePreference(preferenceKey, next);
      onSurfaceChange?.(next);
      if (focus) {
        queueMicrotask(() => tabRefs.current[next]?.focus());
      }
    },
    [chatAvailable, onSurfaceChange, preferenceKey],
  );

  // Roving tabindex over the DYNAMIC surface list — the arrow keys walk
  // whatever chips are offered (two or three), not a hardcoded terminal/chat
  // flip.
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const current = event.currentTarget.dataset.surface as ContentSurface;
    const index = surfaces.indexOf(current);
    if (index === -1) return;
    let next: ContentSurface | null = null;
    if (event.key === 'ArrowLeft') {
      next = surfaces[(index - 1 + surfaces.length) % surfaces.length] ?? null;
    } else if (event.key === 'ArrowRight') {
      next = surfaces[(index + 1) % surfaces.length] ?? null;
    } else if (event.key === 'Home') {
      next = surfaces[0] ?? null;
    } else if (event.key === 'End') {
      next = surfaces[surfaces.length - 1] ?? null;
    }
    if (!next) return;
    event.preventDefault();
    select(next, true);
  };

  const tabId = (s: ContentSurface) => `${id}-${s}-tab`;
  const panelId = (s: ContentSurface) => `${id}-${s}-panel`;

  // The switch shows whenever more than one surface is offered. With Debug
  // always present that is always true, but the condition is kept honest so a
  // single-surface session would render its one pane with no dead switch.
  const showSwitch = surfaces.length > 1;

  /*
   * BOTH is a toggle, not a tab, and it is a sibling of the tablist rather than
   * a member of it: a `role="tab"` inside a tablist promises "selecting me
   * deselects the others", which is the opposite of what this control does. It
   * is only offered when there are two panes to show at once.
   */
  const splitToggleEl = chatAvailable ? (
    <button
      type="button"
      className="pn-surface-switch__tab pn-surface-switch__tab--split"
      data-testid="work-session-split-toggle"
      aria-pressed={splitting}
      disabled={surface === 'debug'}
      title={
        surface === 'debug'
          ? 'Debug uses the whole canvas — leave Debug to show Terminal and Chat together'
          : 'Show Terminal and Chat side by side'
      }
      onClick={toggleSplit}
    >
      Both
    </button>
  ) : null;

  const switchEl = showSwitch ? (
    <div
      className={switchSlot ? 'pn-surface-switch pn-surface-switch--bar' : 'pn-surface-switch'}
      data-testid="work-session-surface-switch"
    >
      <div className="pn-surface-switch__tabs" role="tablist" aria-label="Work session surface">
      {surfaces.map((s) => (
        <button
          key={s}
          ref={(node) => {
            tabRefs.current[s] = node;
          }}
          id={tabId(s)}
          type="button"
          role="tab"
          className="pn-surface-switch__tab"
          data-surface={s}
          aria-selected={surface === s}
          aria-controls={panelId(s)}
          tabIndex={surface === s ? 0 : -1}
          onClick={() => select(s)}
          onKeyDown={onTabKeyDown}
        >
          {SURFACE_LABEL[s]}
        </button>
      ))}
      </div>
      {splitToggleEl}
    </div>
  ) : null;

  return (
    <div className="pn-work-session-content" data-testid="work-session-content" data-surface={surface}>
      {switchEl ? (switchSlot ? createPortal(switchEl, switchSlot) : switchEl) : null}

      {chatAvailable && profile?.compatibility === 'unknown_template' ? (
        <p className="pn-surface-compat" role="status">
          This session uses a newer interaction template. Terminal opens first; Chat uses the core-safe
          message feed and composer.{' '}
          {/* §14.3.1 — preserve and display the failed pinned key/version as safe diagnostics
              rather than hiding the mismatch. The immutable pin is never rewritten to clear this. */}
          <span className="pn-surface-compat__diag">
            Pinned template{' '}
            <code>
              {profile.templateKey}@{profile.templateVersion}
            </code>{' '}
            is not registered in this build.
          </span>
        </p>
      ) : null}

      {/*
       * The panes wrapper is rendered UNCONDITIONALLY, in split and single
       * alike. Wrapping only while split would change the element's position in
       * the tree on every toggle, and React would tear down and rebuild the
       * terminal beneath it — losing the xterm instance and its PTY transport,
       * which is the one thing this component exists to preserve. Layout is a
       * CSS concern here, so only the attribute changes.
       */}
      <div
        className="pn-work-session-content__panes"
        data-layout={splitting ? 'split' : 'single'}
        style={splitting ? ({ ['--pn-split-ratio']: String(ratio) } as CSSProperties) : undefined}
        ref={splitRef}
      >
        <div
          id={panelId('terminal')}
          role="tabpanel"
          aria-labelledby={tabId('terminal')}
          aria-hidden={!(surface === 'terminal' || splitting)}
          className="pn-work-session-content__surface"
          data-active={surface === 'terminal' || splitting ? 'true' : 'false'}
          data-testid="work-session-terminal-surface"
        >
          {terminal}
        </div>
        {splitting ? (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize Terminal and Chat"
            aria-valuenow={Math.round(ratio * 100)}
            aria-valuemin={Math.round(MIN_RATIO * 100)}
            aria-valuemax={Math.round(MAX_RATIO * 100)}
            tabIndex={0}
            className="pn-work-session-content__divider"
            data-testid="work-session-split-divider"
            onPointerDown={onDividerPointerDown}
            onKeyDown={onDividerKeyDown}
          />
        ) : null}
        {chatAvailable ? (
          <div
            id={panelId('chat')}
            role="tabpanel"
            aria-labelledby={tabId('chat')}
            aria-hidden={!(surface === 'chat' || splitting)}
            className="pn-work-session-content__surface"
            data-active={surface === 'chat' || splitting ? 'true' : 'false'}
            data-testid="work-session-chat-surface"
          >
            {chatMounted ? chat : null}
          </div>
        ) : null}
      </div>
      <div
        id={panelId('debug')}
        role="tabpanel"
        aria-labelledby={tabId('debug')}
        aria-hidden={surface !== 'debug'}
        className="pn-work-session-content__surface"
        data-active={surface === 'debug' ? 'true' : 'false'}
        data-testid="work-session-debug-surface"
      >
        {/* Mounted only while selected: unmounting is how the journal poll
            stops the instant the viewer switches away. */}
        {surface === 'debug' ? debug : null}
      </div>
    </div>
  );
}

function resolveInitialSurface({
  requestedSurface,
  chatAvailable,
  preferenceKey,
}: {
  requestedSurface: ContentSurface | null;
  chatAvailable: boolean;
  preferenceKey: string;
}): ContentSurface {
  // The route wins first, but a `chat` request on a session without Chat falls
  // through to the terminal default.
  if (requestedSurface === 'terminal' || requestedSurface === 'debug') return requestedSurface;
  if (requestedSurface === 'chat' && chatAvailable) return 'chat';
  const saved = readPreference(preferenceKey);
  if (saved === 'debug') return 'debug';
  if (saved === 'chat' && chatAvailable) return 'chat';
  if (saved === 'terminal') return 'terminal';
  // USER RULING 2026-08-01 — "I want all the default to be only terminal. I
  // should still be able to switch, but the default is always terminal."
  //
  // The pinned projection's `initialContentSurface` no longer opens the panel.
  // The pin still decides whether Chat EXISTS (chatEnabled); it no longer
  // decides what is shown first. Route (?contentSurface) and the viewer's own
  // prior click on this session still outrank this, so switching works and
  // sticks exactly as before — a freshly spawned session, which has neither,
  // opens on the terminal.
  return 'terminal';
}

function readPreference(key: string): ContentSurface | null {
  if (typeof window === 'undefined') return null;
  try {
    const saved = window.localStorage.getItem(key);
    return saved === 'terminal' || saved === 'chat' || saved === 'debug' ? saved : null;
  } catch {
    return null;
  }
}

function writePreference(key: string, surface: ContentSurface): void {
  writeLocal(key, surface);
}

/** Same storage discipline as `writePreference`, for the non-surface keys. */
function writeLocal(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private/restricted storage must not make a local presentation toggle fail.
  }
}

function readFlag(key: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(key) === 'on';
  } catch {
    return false;
  }
}

function readRatio(key: string): number {
  if (typeof window === 'undefined') return DEFAULT_RATIO;
  try {
    const raw = Number(window.localStorage.getItem(key));
    return Number.isFinite(raw) && raw > 0 ? clampRatio(raw) : DEFAULT_RATIO;
  } catch {
    return DEFAULT_RATIO;
  }
}

function clampRatio(value: number): number {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, value));
}
