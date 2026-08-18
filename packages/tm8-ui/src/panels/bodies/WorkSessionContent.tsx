import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { WorkSessionInteractionProfileProjection } from '@tm8/contract';
import { CONTENT_SURFACES, type ContentSurface } from '../../routes';

const PREFERENCE_PREFIX = 'tm8:work-session-surface:v1';

const SURFACE_LABEL: Readonly<Record<ContentSurface, string>> = {
  terminal: 'Terminal',
  transcript: 'Transcript',
  git: 'Git',
  debug: 'Debug',
  graph: 'Graph',
};

/**
 * A viewer whose last click on this session was the retired Chat chip has
 * `chat` in local storage. Their preference is honoured under its new name
 * rather than silently discarded — losing a viewer's own choice to a rename we
 * made is not something they can diagnose. Same one-directional treatment the
 * route codec gives the token: read, never written.
 */
const LEGACY_SURFACE_PREFERENCE: Readonly<Record<string, ContentSurface>> = {
  chat: 'transcript',
};

export interface WorkSessionContentProps {
  sessionId: string;
  viewerMemberId?: string | null;
  profile?: WorkSessionInteractionProfileProjection | null;
  /** Explicit route selection. It outranks the viewer-local preference. */
  requestedSurface?: ContentSurface | null;
  terminal: ReactNode;
  /**
   * The TRANSCRIPT surface — `execution.transcript` rendered as a conversation.
   * Offered UNCONDITIONALLY, like Git, Debug and Graph. It used to hide behind
   * the interaction profile's immutable chat pin, which was the wrong gate for
   * reading a file off disk: whether an agent keeps a transcript is a fact
   * about the agent tool, not about the session's chat template. The read's own
   * `available:false`-with-reason draws the empty state, which names the cause
   * instead of hiding the tab and leaving nothing to ask about.
   */
  transcript: ReactNode;
  /**
   * The DEBUG surface (the session's CLI journal). Rendered ONLY while selected
   * so its poll stops the moment the viewer leaves it (the "poll only while
   * selected" half of the honesty rule); the terminal and the transcript, by
   * contrast, stay mounted throughout.
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
   * USER RULING 2026-07-31 — the surface tabs belong "at the top row at the
   * right with switchable chips" (given when the strip was Terminal/Chat).
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
 * The work-session Content switch owns presentation only: which chip is
 * selected, and which pane is mounted. Every surface is offered — the last
 * conditional one was Chat, gated by the interaction profile's immutable pin,
 * and it retired with the name. The launch provider/model never enters this
 * component.
 *
 * TERMINAL and TRANSCRIPT mount lazily on first use and then STAY mounted for
 * this panel's lifetime, so switching away and back retains scrollback and
 * scroll position. Debug, Git and Graph mount only while selected, because
 * unmounting is what stops their polls. The transcript sits with the first
 * group despite polling too: its poll already stops on a session that is not
 * live, so unmounting would buy nothing and cost the reader their place.
 * Cross-panel/app-lifetime terminal residency remains a separate layer.
 */
export function WorkSessionContent({
  sessionId,
  viewerMemberId,
  profile,
  requestedSurface = null,
  terminal,
  transcript,
  debug,
  git,
  graph,
  onSurfaceChange,
  switchSlot = null,
}: WorkSessionContentProps) {
  // The offered surfaces, in fixed order. Terminal is always first and is the
  // default; every other surface is always offered. Nothing is gated any more —
  // the last gate was Chat's immutable pin, and it went with Chat.
  const surfaces = useMemo<ContentSurface[]>(
    () => ['terminal', 'transcript', 'git', 'debug', 'graph'],
    [],
  );
  const preferenceKey = `${PREFERENCE_PREFIX}:${viewerMemberId ?? 'anonymous'}:${sessionId}`;
  const initialSurface = useRef<ContentSurface | null>(null);
  if (initialSurface.current === null) {
    initialSurface.current = resolveInitialSurface({ requestedSurface, preferenceKey });
  }
  const [surface, setSurface] = useState<ContentSurface>(initialSurface.current);
  const [terminalMounted, setTerminalMounted] = useState(initialSurface.current === 'terminal');
  const [transcriptMounted, setTranscriptMounted] = useState(
    () => initialSurface.current === 'transcript',
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
    if (requestedSurface) {
      if (requestedSurface === 'transcript') setTranscriptMounted(true);
      if (requestedSurface === 'terminal') setTerminalMounted(true);
      setSurface(requestedSurface);
    }
  }, [requestedSurface]);

  // The clamp that used to live here is gone with the pin: no projection can
  // revoke a surface any more, so there is no unavailable pane to fall off.

  const select = useCallback(
    (next: ContentSurface, focus = false) => {
      if (next === 'transcript') setTranscriptMounted(true);
      if (next === 'terminal') setTerminalMounted(true);
      setSurface(next);
      writePreference(preferenceKey, next);
      onSurfaceChange?.(next);
      if (focus) {
        queueMicrotask(() => tabRefs.current[next]?.focus());
      }
    },
    [onSurfaceChange, preferenceKey],
  );

  // Roving tabindex over the surface list — the arrow keys walk whatever chips
  // are offered rather than a hardcoded pair.
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

      {profile?.compatibility === 'unknown_template' ? (
        <p className="pn-surface-compat" role="status">
          This session uses a newer interaction template. Terminal opens first; the other surfaces
          read this session directly and are unaffected by the template.{' '}
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
        {terminalMounted ? terminal : null}
      </div>
      <div
        id={panelId('transcript')}
        role="tabpanel"
        aria-labelledby={tabId('transcript')}
        aria-hidden={surface !== 'transcript'}
        className="pn-work-session-content__surface"
        data-active={surface === 'transcript' ? 'true' : 'false'}
        data-testid="work-session-transcript-surface"
      >
        {/* Mounted on first use and then KEPT mounted, like the terminal and
            unlike Debug/Git/Graph: its own poll already stops on a session that
            is not live, so unmounting would buy nothing and would cost the
            reader their scroll position on every switch. */}
        {transcriptMounted ? transcript : null}
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
  preferenceKey,
}: {
  requestedSurface: ContentSurface | null;
  preferenceKey: string;
}): ContentSurface {
  // The route wins first. Every surface is offered now, so there is no longer a
  // request that has to fall through to the terminal for want of a pane.
  if (requestedSurface) return requestedSurface;
  const saved = readPreference(preferenceKey);
  if (saved) return saved;
  // USER RULING 2026-08-01 — "I want all the default to be only terminal. I
  // should still be able to switch, but the default is always terminal."
  //
  // The pinned projection's `initialContentSurface` no longer opens the panel.
  // Route (?contentSurface) and the viewer's own prior click on this session
  // still outrank this, so switching works and sticks exactly as before — a
  // freshly spawned session, which has neither, opens on the terminal.
  return 'terminal';
}

function readPreference(key: string): ContentSurface | null {
  if (typeof window === 'undefined') return null;
  try {
    const saved = window.localStorage.getItem(key);
    if (saved === null) return null;
    const canonical = LEGACY_SURFACE_PREFERENCE[saved];
    if (canonical) return canonical;
    return CONTENT_SURFACES.includes(saved as ContentSurface) ? (saved as ContentSurface) : null;
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
