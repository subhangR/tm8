import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { WorkSessionInteractionProfileProjection } from '@tm8/contract';
import type { ContentSurface } from '../../routes';

const PREFERENCE_PREFIX = 'tm8:work-session-surface:v1';

const SURFACE_LABEL: Readonly<Record<ContentSurface, string>> = {
  terminal: 'Terminal',
  chat: 'Chat',
  git: 'Git',
  debug: 'Debug',
  graph: 'Graph',
};

export interface WorkSessionContentProps {
  sessionId: string;
  viewerMemberId?: string | null;
  profile?: WorkSessionInteractionProfileProjection | null;
  /** Explicit route selection. It outranks the viewer-local preference. */
  requestedSurface?: ContentSurface | null;
  /** A render function receives whether the retained terminal is paintable. */
  terminal: ReactNode | ((active: boolean) => ReactNode);
  chat: ReactNode;
  /**
   * The DEBUG surface (the session's CLI journal). Always offered — it does not
   * depend on the immutable chat pin — so the switch shows a Debug chip whether
   * or not Chat exists. Rendered ONLY while selected so its poll stops the
   * moment the viewer leaves it (the "poll only while selected" half of the
   * honesty rule); the terminal, by contrast, stays mounted throughout.
   */
  debug?: ReactNode;
  /**
   * The GIT surface (the session's worktree rail: status, diff, and the
   * checkpoint/rollback/commit/merge verbs). Offered on the same terms as
   * Debug — no pin — and mounted only while selected, because its status
   * poll must stop the moment the viewer leaves it.
   */
  git?: ReactNode;
  /**
   * The GRAPH surface (what this session is connected to). Offered on the same
   * terms as Debug — it depends on no pin — and mounted only while selected,
   * for the same reason: unmounting is what stops its poll.
   */
  graph?: ReactNode;
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
  git,
  graph,
  onSurfaceChange,
  switchSlot = null,
}: WorkSessionContentProps) {
  const chatAvailable = profile?.chatEnabled === true;
  // The offered surfaces, in fixed order. Terminal is always first (and the
  // default); Chat is gated by the immutable pin; Debug and Graph are always
  // offered, in that order.
  const surfaces = useMemo<ContentSurface[]>(
    () => ['terminal', ...(chatAvailable ? (['chat'] as const) : []), 'git', 'debug', 'graph'],
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

  const switchEl = showSwitch ? (
    <div
      className={switchSlot ? 'pn-surface-switch pn-surface-switch--bar' : 'pn-surface-switch'}
      role="tablist"
      aria-label="Work session surface"
      data-testid="work-session-surface-switch"
    >
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

      <div
        id={panelId('terminal')}
        role="tabpanel"
        aria-labelledby={tabId('terminal')}
        aria-hidden={surface !== 'terminal'}
        className="pn-work-session-content__surface"
        data-active={surface === 'terminal' ? 'true' : 'false'}
        data-testid="work-session-terminal-surface"
      >
        {typeof terminal === 'function' ? terminal(surface === 'terminal') : terminal}
      </div>
      {chatAvailable ? (
        <div
          id={panelId('chat')}
          role="tabpanel"
          aria-labelledby={tabId('chat')}
          aria-hidden={surface !== 'chat'}
          className="pn-work-session-content__surface"
          data-active={surface === 'chat' ? 'true' : 'false'}
          data-testid="work-session-chat-surface"
        >
          {chatMounted ? chat : null}
        </div>
      ) : null}
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
      <div
        id={panelId('git')}
        role="tabpanel"
        aria-labelledby={tabId('git')}
        aria-hidden={surface !== 'git'}
        className="pn-work-session-content__surface"
        data-active={surface === 'git' ? 'true' : 'false'}
        data-testid="work-session-git-surface"
      >
        {/* Mounted only while selected — the status poll stops on unmount. */}
        {surface === 'git' ? git : null}
      </div>
      <div
        id={panelId('graph')}
        role="tabpanel"
        aria-labelledby={tabId('graph')}
        aria-hidden={surface !== 'graph'}
        className="pn-work-session-content__surface"
        data-active={surface === 'graph' ? 'true' : 'false'}
        data-testid="work-session-graph-surface"
      >
        {/* Mounted only while selected — same reason as Debug: unmounting is
            what stops the connection poll. */}
        {surface === 'graph' ? graph : null}
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
  if (
    requestedSurface === 'terminal' ||
    requestedSurface === 'git' ||
    requestedSurface === 'debug' ||
    requestedSurface === 'graph'
  ) {
    return requestedSurface;
  }
  if (requestedSurface === 'chat' && chatAvailable) return 'chat';
  const saved = readPreference(preferenceKey);
  if (saved === 'git' || saved === 'debug' || saved === 'graph') return saved;
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
    return saved === 'terminal' || saved === 'chat' || saved === 'git' || saved === 'debug' || saved === 'graph'
      ? saved
      : null;
  } catch {
    return null;
  }
}

function writePreference(key: string, surface: ContentSurface): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, surface);
  } catch {
    // Private/restricted storage must not make a local presentation toggle fail.
  }
}
