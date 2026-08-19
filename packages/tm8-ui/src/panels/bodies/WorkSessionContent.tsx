import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { WorkSessionInteractionProfileProjection } from '@tm8/contract';
import { CONTENT_SURFACES, type ContentSurface } from '../../routes';
import { useMobileSurface } from '../../mobile';
import { DisabledIconControl } from '../honesty/DisabledWithReason';
import './work-session-content-phone.css';

const PREFERENCE_PREFIX = 'tm8:work-session-surface:v1';

const SURFACE_LABEL: Readonly<Record<ContentSurface, string>> = {
  terminal: 'Terminal',
  transcript: 'Transcript',
  git: 'Git',
  debug: 'Debug',
  graph: 'Graph',
};

/**
 * WHAT A PHONE OFFERS, AND — SEPARATELY — WHAT IT REFUSES.
 *
 * Five surfaces at 390px is the "do not ship them squashed" case: five chips in
 * a 30px bar measured 22px tall and helped push the panel's own control cluster
 * off the right edge (DEF-001, DEF-029). Narrowing them all until they fit
 * would produce five surfaces that are each unusable rather than two that work.
 *
 * SO THE PHONE OFFERS TWO AND SAYS SO ABOUT THE OTHER THREE. Dropping them
 * silently is not the cheaper honest option — it is the DEF-003 pathology, the
 * one this program has already paid for: the phone had no account menu and
 * every tap census scored those screens as PASSING, because absence measures as
 * health and no instrument can see a thing that is not there. A surface removed
 * without a word is a surface nobody can report missing.
 *
 * THE THREE REFUSALS, each with its own reason rather than one blanket
 * sentence — a refusal that does not say WHY is a shrug:
 *
 *   git    Already ruled DEFER for the phone at the route level, and the note
 *          with that ruling is the useful half: the git facts a phone reader
 *          needs already live in entity detail. The surface itself is a
 *          worktree rail — status, diff, and the checkpoint / rollback / commit
 *          / merge verbs — which is a desktop arrangement, and a diff read at
 *          390px is a diff misread.
 *   debug  The CLI journal: a wide monospace log for diagnosing an agent. It
 *          wraps into unreadability at this width, and nothing about it is a
 *          phone task.
 *   graph  The `graph` route is REFUSED FOREVER by owner ruling. A graph canvas
 *          reached through a tab instead of an address is the same refused
 *          arrangement arriving by a side door, and shipping it here would make
 *          the route's refusal card the thing that is lying.
 *
 * Each one is `wontfix-on-phone` and is STATED on screen, never merely absent.
 */
const PHONE_SURFACES: readonly ContentSurface[] = ['transcript', 'terminal'];

const PHONE_REFUSED: Readonly<Partial<Record<ContentSurface, string>>> = {
  git: 'The worktree rail — status, diff, and the checkpoint, rollback, commit and merge verbs — has no phone arrangement. A diff read at this width is a diff misread. This session’s git facts are in the entity’s own detail.',
  debug: 'The session’s CLI journal is a wide monospace log for diagnosing an agent. It has no phone arrangement, and wrapping it to fit would not make it readable.',
  graph: 'The graph is refused on phones outright, at the route as well as here — so this is the same refusal you would meet by following a graph link, not a second opinion about it.',
};

const PHONE_REFUSED_LIST = (Object.keys(PHONE_REFUSED) as ContentSurface[])
  .map((s) => SURFACE_LABEL[s])
  .join(' · ');

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
  /*
   * ONE FORK, FROM THE HOST. Not `useShellKind()` and not a media query: the
   * shell decision is `(pointer: coarse) && width < 500` and `GateApp` has made
   * it once already, so a second answer here could disagree with the one that
   * chose the shell this body is rendering inside. Off the phone this is
   * `false` and every branch it guards is unreachable by construction.
   */
  const { oneSurface } = useMobileSurface();

  // The offered surfaces, in fixed order. On a desktop Terminal is first and is
  // the default; every other surface is always offered, and nothing is gated —
  // the last gate was Chat's immutable pin, and it went with Chat.
  //
  // THE PHONE OFFERS TWO, TRANSCRIPT FIRST. See PHONE_SURFACES above for why
  // three are refused rather than narrowed, and PHONE_REFUSED for each reason.
  const surfaces = useMemo<ContentSurface[]>(
    () => (oneSurface ? [...PHONE_SURFACES] : ['terminal', 'transcript', 'git', 'debug', 'graph']),
    [oneSurface],
  );
  const preferenceKey = `${PREFERENCE_PREFIX}:${viewerMemberId ?? 'anonymous'}:${sessionId}`;
  const initialSurface = useRef<ContentSurface | null>(null);
  if (initialSurface.current === null) {
    initialSurface.current = resolveInitialSurface({ requestedSurface, preferenceKey, oneSurface });
  }
  /*
   * WHAT WAS ASKED FOR AND CANNOT BE GIVEN — held, and answered by name.
   *
   * A viewer arrives wanting a surface this shell refuses. It is a real arrival
   * rather than an error, and rewriting it silently to Transcript would leave
   * the request and the screen disagreeing with nothing on screen saying so.
   *
   * TWO SOURCES, AND THE SECOND IS THE ONE THAT ACTUALLY FIRES TODAY. I wrote
   * this reading `requestedSurface` alone and then checked whether that could
   * ever be non-null here — it cannot. `EntityView`, which is the ONLY host the
   * phone shell mounts, holds `contentSurfaces` in COMPONENT STATE and passes
   * the route's value to nobody; the navStore's `contentSurface` reaches
   * `nav.surfaceOf` and thus WorkspaceView, which has no phone arrangement at
   * all. So the route arm is correct, and on this shell it is dead — it starts
   * working the day `contentSurface` becomes route state on the phone, which is
   * DEF-045's shape and is not this row.
   *
   * THE PREFERENCE ARM IS REACHABLE NOW, and it is the likelier arrival anyway:
   * `tm8:work-session-surface:v1` is written by the viewer's own last click on
   * THIS session, per member, on whatever device made it. Somebody reading a
   * session's Git rail on a desktop and then opening the same session on their
   * phone is the ordinary case, not the exotic one — and without this they
   * would land on the transcript with no explanation of why the surface they
   * left is gone.
   *
   * Resolved ONCE, beside the initial surface, because it describes the ARRIVAL.
   * Re-deriving it every render would keep the card up after the viewer moved on
   * — an answer to a question they have stopped asking.
   */
  const arrivalRefusal = useRef<ContentSurface | null>(null);
  if (initialSurface.current !== null && arrivalRefusal.current === null) {
    const asked = requestedSurface ?? readPreference(preferenceKey);
    arrivalRefusal.current = oneSurface && asked && PHONE_REFUSED[asked] ? asked : null;
  }
  const [refusalDismissed, setRefusalDismissed] = useState(false);
  const refusedSurface = refusalDismissed ? null : arrivalRefusal.current;
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
      /* A refused surface must not become the SELECTED one: `surface` drives
         the tablist's `aria-selected`, and selecting a tab that is not offered
         would leave the switch announcing a selection nobody can see. The
         refusal is rendered from `refusedSurface`, which reads the request
         directly and is unaffected by this clamp. */
      if (oneSurface && PHONE_REFUSED[requestedSurface]) return;
      if (requestedSurface === 'transcript') setTranscriptMounted(true);
      if (requestedSurface === 'terminal') setTerminalMounted(true);
      setSurface(requestedSurface);
    }
  }, [requestedSurface, oneSurface]);

  // The clamp that used to live here is gone with the pin: no projection can
  // revoke a surface any more, so there is no unavailable pane to fall off.

  const select = useCallback(
    (next: ContentSurface, focus = false) => {
      if (next === 'transcript') setTranscriptMounted(true);
      if (next === 'terminal') setTerminalMounted(true);
      /* The arrival refusal answers "why am I not where I asked to be". Once
         the viewer has chosen a surface for themselves they have stopped
         asking, and a card that stays is an answer to a dead question taking
         space off the surface they did choose. */
      setRefusalDismissed(true);
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

  /*
   * THE PHONE DOES NOT RIDE THE PANEL BAR, and this is half of DEF-029.
   *
   * `switchSlot` portals the switch into `.pn-panelbar`, which is a fixed 30px
   * row — and the `--bar` modifier exists precisely to strip the control's own
   * floor to fit it there: `min-height: 44px` becomes `22px`, knowingly traded
   * (panels.css records the trade, and the tap census measured the result at
   * 22px on all five chips). That trade is defensible on a desktop pointer and
   * is not available to a thumb.
   *
   * Two things flip together by declining the slot. The chips get the 44px
   * floor the un-modified `.pn-surface-switch__tab` already carries, so the
   * fix is subtraction rather than a new override; and five elements leave the
   * width budget of the row whose end cluster was pushed 67px off the screen
   * (DEF-001). It does not close DEF-001 on its own — the Terminate cluster
   * still has to stop sharing a 30px row — and it is not claimed to.
   */
  const ridesPanelBar = switchSlot !== null && !oneSurface;

  const tabs = surfaces.map((s) => (
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
  ));

  /*
   * THE PHONE'S ROW IS A ROW CONTAINING A TABLIST, not a tablist doing duty as
   * a row — and that is a semantics decision, not a markup preference.
   *
   * The refusal marker has to sit in this row: it is the answer to "where did
   * Git, Debug and Graph go", and the row is where the reader is looking when
   * they ask. But `role="tablist"` promises that its children are TABS, and the
   * marker is a `DisabledIconControl` carrying `role="button"`. Put inside, it
   * would be a non-tab child of a tablist — a screen reader is told there is a
   * fourth thing in the tab set, walks to it, and finds something it cannot
   * select. That is the same "control that cannot perform" the shell contract
   * bans in pixels, arriving through the accessibility tree instead.
   *
   * So the ROW takes `.pn-surface-switch` (the styling, the height, the
   * hairline) and an inner element takes the tablist role. The desktop keeps
   * exactly the markup it had — one element that is both — because it has no
   * marker to place and no reason to grow a wrapper.
   */
  const switchEl = showSwitch ? (
    oneSurface ? (
      <div className="pn-surface-switch" data-arrangement="phone-row">
        <div
          className="pn-surface-switch__tabs"
          role="tablist"
          aria-label="Work session surface"
          data-testid="work-session-surface-switch"
        >
          {tabs}
        </div>
        {/*
          THE THREE THAT ARE NOT HERE, SAID OUT LOUD.

          ONE control rather than three: three separate refusals would be three
          things a thumb can find and none of them can perform, which is the
          furniture this program keeps removing. `DisabledIconControl` is the
          app-wide honesty form, so it carries its reason.

          ── AND IT IS A REAL TAP TARGET. THIS COMMENT USED TO SAY IT IS NOT. ──
          The removed clause read: "per RULE R2 a disabled element is correctly
          excluded from the 44px tap bar, because there is nothing to tap and a
          size assertion on it would be meaningless." The second half is false
          BECAUSE the first half is true:

            DisabledWithReason.tsx:67-79   role="button" · tabIndex={0}
                                           {...tip.triggerProps}
            useReasonDisclosure.ts:65      triggerProps = { onClick: toggle, … }

          THE TAP IS HOW THE REASON OPENS. It is not hover-driven, so it works on
          a coarse pointer — which is why this component was chosen — and it is
          the ONLY route to learning why Git, Debug and Graph are gone.

          MEASURED, Case A `c7c09a38`: 116 x 22. Under the floor, and invisible
          to every census by construction: `aria-disabled` puts it in
          `tapTargetsInert`, which no headline reads. The better-behaved the
          refusal, the more invisible its geometry.

          R2 IS NOT WRONG AND IS NOT BEING ARGUED WITH. A disabled control has
          nothing to PERFORM. What this one has is a DISCLOSURE, and that is a
          different question the rule was never asked.

          NOT SIZED HERE: `hon-disabled--tooltip` paints nothing at rest
          (`kit.css` — `border: 0`, `background: transparent`), so a 44px floor
          would produce an invisible 44px target over a 22px visible one. It is
          a member of the affordance class escalated against the dated ruling in
          `panels.css:54-60`, and one lane must not restyle a shared honesty
          primitive while that is open.
        */}
        <span className="pn-surface-switch__refused" data-testid="work-session-surface-refused-marker">
          <DisabledIconControl
            label={`${PHONE_REFUSED_LIST} — not on a phone`}
            reason={{
              cause: `${PHONE_REFUSED_LIST} have no phone arrangement`,
              remedy: 'each is refused for its own reason — open this session on a desktop to reach them',
            }}
          >
            {PHONE_REFUSED_LIST}
          </DisabledIconControl>
        </span>
      </div>
    ) : (
      <div
        className={ridesPanelBar ? 'pn-surface-switch pn-surface-switch--bar' : 'pn-surface-switch'}
        role="tablist"
        aria-label="Work session surface"
        data-testid="work-session-surface-switch"
        data-arrangement={ridesPanelBar ? 'panel-bar' : 'own-row'}
      >
        {tabs}
      </div>
    )
  ) : null;

  return (
    <div
      className="pn-work-session-content"
      data-testid="work-session-content"
      data-surface={surface}
      /* The instrument's witness for WHICH arrangement it photographed. Two
         fields rather than one boolean: `data-surface` says what is showing,
         this says which set of surfaces was on offer to show it. */
      data-arrangement={oneSurface ? 'phone' : 'desktop'}
    >
      {switchEl ? (ridesPanelBar && switchSlot ? createPortal(switchEl, switchSlot) : switchEl) : null}

      {/*
        A ROUTE THAT NAMED A REFUSED SURFACE GETS AN ANSWER ABOUT THAT SURFACE.

        Not a generic card and not silence. The reader followed a link that says
        `git`, so the refusal says `git` and gives git's own reason — the shell's
        rule that "a refusal card must be true" applies to a surface inside a
        panel exactly as it does to a route, and a card that could not name what
        was asked for would be the vague kind this program has already filed a
        row against (DEF-012).

        It renders ABOVE the offered surfaces rather than instead of them: the
        session is still open and still readable, so the refusal takes the
        space of a statement and not the space of a screen.
      */}
      {refusedSurface ? (
        <div
          className="pn-surface-refusal"
          role="status"
          data-testid="work-session-surface-refused"
          data-surface-refused={refusedSurface}
        >
          <p className="pn-surface-refusal__head">
            “{SURFACE_LABEL[refusedSurface]}” doesn’t have a phone arrangement.
          </p>
          <p className="pn-surface-refusal__body">{PHONE_REFUSED[refusedSurface]}</p>
          <p className="pn-surface-refusal__body">
            The link is a real address and it still opens this surface on a desktop.
            {' '}
            {SURFACE_LABEL[surface]} is showing below.
          </p>
        </div>
      ) : null}

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
      {/*
        THE REFUSED THREE ARE NOT RENDERED AT ALL ON A PHONE — not even as the
        empty shells they would be.

        Each is a `tabpanel` pointing at `aria-labelledby={tabId(...)}`, and on
        this arrangement those tab ids do not exist. A dangling `aria-labelledby`
        is not a cosmetic slip: it is three unlabelled tabpanels in the
        accessibility tree of a surface whose whole claim is that it is honest
        about what it does not have. They were already inert here (`surface` is
        clamped, so their bodies never mount and their polls never start); this
        removes the empty boxes that inertness left behind.
      */}
      {oneSurface ? null : (
        <>
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
        </>
      )}
    </div>
  );
}

function resolveInitialSurface({
  requestedSurface,
  preferenceKey,
  oneSurface,
}: {
  requestedSurface: ContentSurface | null;
  preferenceKey: string;
  oneSurface: boolean;
}): ContentSurface {
  // The route wins first. Every surface is offered now, so there is no longer a
  // request that has to fall through to the terminal for want of a pane.
  //
  // EXCEPT one this shell refuses — the request is still honoured as far as it
  // can be (the refusal names it), but it cannot become the SELECTED surface,
  // because the phone has no tab for it. Same clamp as the hydration effect.
  if (requestedSurface && !(oneSurface && PHONE_REFUSED[requestedSurface])) return requestedSurface;
  const saved = readPreference(preferenceKey);
  if (saved && !(oneSurface && PHONE_REFUSED[saved])) return saved;
  // USER RULING 2026-08-01 — "I want all the default to be only terminal. I
  // should still be able to switch, but the default is always terminal."
  //
  // The pinned projection's `initialContentSurface` no longer opens the panel.
  // Route (?contentSurface) and the viewer's own prior click on this session
  // still outrank this, so switching works and sticks exactly as before — a
  // freshly spawned session, which has neither, opens on the terminal.
  //
  // ── THE PHONE'S FALLBACK IS THE TRANSCRIPT, AND IT IS A DIVERGENCE ───────
  //
  // Flagged as one rather than slipped in, because the ruling above is the
  // user's and this is not: the phone brief says the transcript is the primary
  // surface there. Both can be true, and this is where they meet.
  //
  // The ruling was given for the panel a desktop draws — where the terminal is
  // "the main thing of our app", takes every pixel to the panel's bottom edge,
  // and has a real keyboard behind it. At 390px the same terminal is ~48
  // columns with an on-screen bar supplying the keys the device cannot produce,
  // and its own width note says full-screen tools will wrap. Reading what the
  // agent SAID is what a phone is good at; driving a PTY is what it is worst
  // at. Opening a phone on the terminal is opening it on the harder half.
  //
  // WHAT IS NOT CHANGED, which is what keeps this a fallback and not an
  // override: the precedence above is untouched. An address naming a surface
  // still wins, and the viewer's own prior click on THIS session still wins
  // over both. This only answers the case where nobody has said anything —
  // a freshly spawned session, opened on a phone, by someone who has not
  // chosen yet. It is the one arm the ruling's own reasoning does not reach.
  return oneSurface ? 'transcript' : 'terminal';
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
