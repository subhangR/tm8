import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { WorkSessionInteractionProfileProjection } from '@tm8/contract';
import type { ContentSurface } from '../../routes';

const SURFACES: readonly ContentSurface[] = ['terminal', 'chat'];
const PREFERENCE_PREFIX = 'tm8:work-session-surface:v1';

export interface WorkSessionContentProps {
  sessionId: string;
  viewerMemberId?: string | null;
  profile?: WorkSessionInteractionProfileProjection | null;
  /** Explicit route selection. It outranks the viewer-local preference. */
  requestedSurface?: ContentSurface | null;
  terminal: ReactNode;
  chat: ReactNode;
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
 * decides whether Chat exists; the launch provider/model never enters this
 * component. Both panes stay mounted after render so xterm and its PTY
 * transport keep exactly the same component instance while Chat is visible.
 */
export function WorkSessionContent({
  sessionId,
  viewerMemberId,
  profile,
  requestedSurface = null,
  terminal,
  chat,
  onSurfaceChange,
  switchSlot = null,
}: WorkSessionContentProps) {
  const chatAvailable = profile?.chatEnabled === true;
  const preferenceKey = `${PREFERENCE_PREFIX}:${viewerMemberId ?? 'anonymous'}:${sessionId}`;
  const [surface, setSurface] = useState<ContentSurface>(() =>
    resolveInitialSurface({ requestedSurface, profile, preferenceKey }),
  );
  const [chatMounted, setChatMounted] = useState(() =>
    resolveInitialSurface({ requestedSurface, profile, preferenceKey }) === 'chat',
  );
  const previousRequest = useRef(requestedSurface);
  const terminalTab = useRef<HTMLButtonElement>(null);
  const chatTab = useRef<HTMLButtonElement>(null);
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
        queueMicrotask(() => (next === 'terminal' ? terminalTab : chatTab).current?.focus());
      }
    },
    [chatAvailable, onSurfaceChange, preferenceKey],
  );

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!chatAvailable) return;
    const current = event.currentTarget.dataset.surface as ContentSurface;
    let next: ContentSurface | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      next = current === 'terminal' ? 'chat' : 'terminal';
    } else if (event.key === 'Home') {
      next = SURFACES[0];
    } else if (event.key === 'End') {
      next = SURFACES[SURFACES.length - 1];
    }
    if (!next) return;
    event.preventDefault();
    select(next, true);
  };

  if (!chatAvailable) {
    return (
      <div className="pn-work-session-content" data-testid="work-session-content">
        {terminal}
      </div>
    );
  }

  const terminalTabId = `${id}-terminal-tab`;
  const chatTabId = `${id}-chat-tab`;
  const terminalPanelId = `${id}-terminal-panel`;
  const chatPanelId = `${id}-chat-panel`;

  const switchEl = (
    <div
      className={switchSlot ? 'pn-surface-switch pn-surface-switch--bar' : 'pn-surface-switch'}
      role="tablist"
      aria-label="Work session surface"
      data-testid="work-session-surface-switch"
    >
      <button
        ref={terminalTab}
        id={terminalTabId}
        type="button"
        role="tab"
        className="pn-surface-switch__tab"
        data-surface="terminal"
        aria-selected={surface === 'terminal'}
        aria-controls={terminalPanelId}
        tabIndex={surface === 'terminal' ? 0 : -1}
        onClick={() => select('terminal')}
        onKeyDown={onTabKeyDown}
      >
        Terminal
      </button>
      <button
        ref={chatTab}
        id={chatTabId}
        type="button"
        role="tab"
        className="pn-surface-switch__tab"
        data-surface="chat"
        aria-selected={surface === 'chat'}
        aria-controls={chatPanelId}
        tabIndex={surface === 'chat' ? 0 : -1}
        onClick={() => select('chat')}
        onKeyDown={onTabKeyDown}
      >
        Chat
      </button>
    </div>
  );

  return (
    <div className="pn-work-session-content" data-testid="work-session-content" data-surface={surface}>
      {switchSlot ? createPortal(switchEl, switchSlot) : switchEl}

      {profile.compatibility === 'unknown_template' ? (
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
        id={terminalPanelId}
        role="tabpanel"
        aria-labelledby={terminalTabId}
        aria-hidden={surface !== 'terminal'}
        className="pn-work-session-content__surface"
        data-active={surface === 'terminal' ? 'true' : 'false'}
        data-testid="work-session-terminal-surface"
      >
        {terminal}
      </div>
      <div
        id={chatPanelId}
        role="tabpanel"
        aria-labelledby={chatTabId}
        aria-hidden={surface !== 'chat'}
        className="pn-work-session-content__surface"
        data-active={surface === 'chat' ? 'true' : 'false'}
        data-testid="work-session-chat-surface"
      >
        {chatMounted ? chat : null}
      </div>
    </div>
  );
}

function resolveInitialSurface({
  requestedSurface,
  profile,
  preferenceKey,
}: {
  requestedSurface: ContentSurface | null;
  profile?: WorkSessionInteractionProfileProjection | null;
  preferenceKey: string;
}): ContentSurface {
  if (!profile?.chatEnabled) return 'terminal';
  if (requestedSurface === 'terminal' || requestedSurface === 'chat') return requestedSurface;
  const saved = readPreference(preferenceKey);
  if (saved) return saved;
  if (profile.compatibility === 'unknown_template') return 'terminal';
  return profile.initialContentSurface;
}

function readPreference(key: string): ContentSurface | null {
  if (typeof window === 'undefined') return null;
  try {
    const saved = window.localStorage.getItem(key);
    return saved === 'terminal' || saved === 'chat' ? saved : null;
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
