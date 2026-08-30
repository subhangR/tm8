/**
 * HomePage — the merged single home (user ruling, task 01a0027d, 2026-08-14).
 *
 * A DASHBOARD, NOT A DIRECTORY (owner ruling, 2026-08-30). Every element here
 * is one of three things — something LIVE, something MINE and recent, or an
 * ACTION I can start. Anything that is none of the three belongs on another
 * screen:
 *
 *   1. MY LIVE SESSIONS first: what is running right now, wearing the seam's
 *      verdict rather than its own record, so a session the node cannot
 *      account for reads `stale` instead of claiming to run.
 *   2. NEEDS YOU beneath it — triage outranks everything.
 *   3. MY TASKS — mine, and recent.
 *   4. The CHAT is the hero, mounted solo (its thread sidebar hidden by this
 *      module's stylesheet; full thread management stays on Messages).
 *
 * The WORKSPACE MAP used to lead this page and is gone: it rendered the same
 * `EntityNavigationGroup[]` as the rail beside it, so the screen asked "what
 * kinds of thing exist here" twice and answered "what am I doing" nowhere.
 * The taxonomy lives in the rail, once; `Open Workspace` is still the escape
 * hatch, so Home never becomes a capability cul-de-sac.
 *
 * WHAT THIS FILE DELIBERATELY REUSES rather than re-implements:
 *   - `useHomeData` / `composeMyWork` (src/home) — the NEEDS YOU composition
 *     with all its honesty rules (viewer-unknown ≠ empty, refused inbox ≠
 *     quiet inbox). This module renders the section; it re-derives nothing.
 *   - `homeRowOf` — the one summary→row projection, so a rail card's status
 *     word and dot obey the same verdict-outranks-record law as every other
 *     surface.
 *
 * Rails are GLANCEABLE, not exhaustive: the top rows by `activityAt`,
 * sideways-scrolling, with the rail header opening the full collection. Depth
 * lives in Workspace; this page is peripheral vision around the conversation.
 *
 * §15.2: no kind literal appears in this directory — the rail and presence
 * kinds come from `domain/home-page.ts`, presence state is read structurally
 * (`'liveWork' in state`), and every glyph resolves through the registry.
 */
import { useMemo, type ReactNode } from 'react';
import {
  entityNavigationLabel,
  getKind,
  KindIcon,
  type EntityNavigationGroup,
} from '../domain';
import {
  composeMyWork,
  useHomeData,
  type HomeScreenData,
  type HomeSection,
} from '../home';
import { EntityNavigationMetrics } from '../navigation';
import './home-page.css';

export interface HomePageProps {
  data: HomeScreenData;
  /** The chat surface — the host mounts it (seam wiring is its business). */
  chat: ReactNode;
  /**
   * The entity opened FROM this page, shown BESIDE it rather than instead of
   * it. Absent ⇒ no column at all: a host with nowhere to put a detail must
   * not be handed a slot that draws an empty one.
   *
   * The column AND its chrome are the host's (`views/HomeView`), exactly as
   * they are on the channel screen — this page only makes room. That is why
   * the node lands here unwrapped: the separator that resizes the column has
   * to be its SIBLING, not something inside it.
   */
  aside?: ReactNode;
  /**
   * The icon rail (task 01a00932 R4) — the host builds it (its state is the
   * host's root selection); this page only seats it leftmost in the row,
   * exactly as it makes room for the aside.
   */
  rail?: ReactNode;
  /**
   * Column A's separator — the drag handle when A is open, the reveal button
   * when it is collapsed (task 01a00ac2). It seats INSIDE the chat section
   * rather than beside the rail because A is not a child of this page at all:
   * it is `.tch-sidebar`, a grid track inside the chat surface the host hands
   * down. The section is the nearest box that starts and ends exactly where A
   * does, which is what lets the handle line up with the edge it moves
   * without this page having to know anything about that grid.
   */
  listRail?: ReactNode;
  /** Rail + column A collapsed as one. Read by CSS off `data-focus`. */
  focus?: boolean;
  /** The exact enriched model also rendered by the persistent entity rail. */
  navigationGroups?: readonly EntityNavigationGroup[];
  /** A kind root is current only while Home is browsing an entity list. */
  activeKind?: string | null;
  /** Absent keeps the map informative but non-interactive. */
  onOpenKind?(kind: string): void;
  onOpenEntity(id: string): void;
  onOpenWorkspace(): void;
  /** Back to the new-conversation composer. Chat's own create. */
  onNewChat?: (() => void) | undefined;
  /** Create a kind and land on its root. The host already owns this verb. */
  onCreateKind?: ((kind: string) => void) | undefined;
  /**
   * WHY A CREATE IS REFUSED, when it is. A refused verb renders DISABLED WITH
   * THE REASON rather than vanishing — H2's ruling and it is right: a missing
   * button reads as a missing feature, a disabled one that says why reads as a
   * product that knows its own state. That difference is visible in a demo.
   */
  createKindUnavailable?: ((kind: string) => { cause: string; remedy: string } | null) | undefined;
}

/**
 * START — the three verbs, first, before anything that merely exists.
 *
 * The owner asked for exactly these three by name and asked for them FIRST.
 * They are not new plumbing: `HomeChatRegions` already carries `onShowChat`
 * and `onCreateKind`, and `home-dashboard.ts` already declares this shape as
 * `HomeCreateVerbs` — which had no consumer until now. This is the consumer.
 *
 * ONE CONTROL PER VERB. `ListRootHeader` renders a create for the current kind
 * and the chat surface has its own `+ New chat`; this row is the SAME handlers
 * reached from the one screen the owner starts on, not a second set. Two
 * controls for one verb is how "options repeating" comes back.
 */
function HomeStart({
  onNewChat,
  onCreateKind,
  createKindUnavailable,
}: {
  onNewChat?: (() => void) | undefined;
  onCreateKind?: ((kind: string) => void) | undefined;
  createKindUnavailable?: ((kind: string) => { cause: string; remedy: string } | null) | undefined;
}) {
  /* A verb whose handler is absent is not rendered at all — that is a host
     that never wired it, which is different from a host that wired it and the
     server refused. The second gets a disabled control with its reason; the
     first would be a button we invented. */
  const kindVerb = (kind: string, label: string) => {
    if (!onCreateKind) return null;
    const refusal = createKindUnavailable?.(kind) ?? null;
    if (refusal) {
      return (
        <span className="hp-start__verb hp-start__verb--off" title={`${refusal.cause} — ${refusal.remedy}`}>
          {label}
        </span>
      );
    }
    return (
      <button type="button" className="hp-start__verb" onClick={() => onCreateKind(kind)}>
        {label}
      </button>
    );
  };

  const chat = onNewChat ? (
    <button type="button" className="hp-start__verb" onClick={onNewChat}>
      New chat
    </button>
  ) : null;
  const session = kindVerb('session', 'New session');
  const task = kindVerb('task', 'New task');

  /* Nothing wired ⇒ no row, rather than an empty box asserting "you can start
     three things" and offering none. */
  if (!chat && !session && !task) return null;

  return (
    <section className="hp-start" aria-label="Start something">
      {chat}
      {session}
      {task}
    </section>
  );
}


function AttentionCard({ section, onOpen }: { section: HomeSection; onOpen(id: string): void }) {
  return (
    <article className="hp-attention" aria-label={section.label} data-testid="hp-needs-you">
      <h2 className="hp-attention__eyebrow k-label">{section.label}</h2>
      <div className="hp-attention__rows">
        {section.rows.map((row) => (
          <button
            key={row.id}
            type="button"
            className={`hp-attention__row k-press hp-attention__row--${row.tone}`}
            title={row.detail ?? row.title}
            onClick={() => onOpen(row.id)}
          >
            <span className="hp-attention__status">
              {row.word ? (
                <span className={`hp-card__word hp-card__word--${row.tone}`}>
                  {row.dot ? (
                    <span className={`hp-card__dot hp-card__dot--${row.dot}`} aria-hidden="true" />
                  ) : null}
                  {row.word}
                </span>
              ) : null}
            </span>
            <span className="hp-attention__title">{row.title}</span>
            {row.kind ? (
              <span className="hp-attention__ref">
                <span className="hp-attention__ref-mark" aria-hidden>
                  <KindIcon kind={row.kind} />
                </span>
                {getKind(row.kind).label}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </article>
  );
}


export function HomePage(props: HomePageProps) {
  const { data } = props;
  const home = useHomeData(data);

  /* THE COMPOSITION WAS ALWAYS COMPLETE; HOME THREW THREE QUARTERS OF IT AWAY.
   *
   * `composeMyWork` returns four sections — NEEDS YOU, MY LIVE SESSIONS, MY
   * TASKS, MENTIONS & ASSIGNMENTS. This memo used to `.find()` the needs-you
   * one and discard the rest on every render, under a comment saying the
   * others "render as rails below". That stopped being true at R4
   * (2026-08-15), when the rails retired to the Work tab — the comment
   * outlived the code by a fortnight.
   *
   * So "current running things" (owner, 2026-08-30) is not a new capability
   * here. MY LIVE SESSIONS was already composed from the seam VERDICT rather
   * than the record — a session whose row claims running while the node holds
   * no PTY reads `stale`, which is the honest word — and then dropped on the
   * floor. It is wired below.
   */
  const work = useMemo(() => {
    const work = composeMyWork({
      sessionPool: home.sessionPool,
      myTasks: home.myTasks,
      myReview: home.myReview,
      livenessOf: data.livenessOf,
      activity: data.activity,
      notifications: home.notifications,
      notificationsError: home.notificationsError,
      viewerKnown: home.viewer !== null,
      viewerError: home.viewerError,
    });
    return {
      needsYou: work.sections.find((section) => section.emphasis === 'needs-you') ?? null,
    };
  }, [home, data.livenessOf, data.activity]);

  /* THREE STATES, AND THIS ONE RENDERS ONLY THE THIRD.
   *
   * `rowsFor` returns [] while a kind is still hydrating, so an empty array
   * here means "pending" and "genuinely empty" indistinguishably. A strip that
   * drew `MY LIVE SESSIONS · 0` off that array would assert the workspace is
   * empty during the window where the screen knows nothing — the same defect
   * as "No agent teammate is available in this space" in a space that has 34,
   * and on a demo it lands in the first second of the screen.
   *
   * So a strip with no rows renders NOTHING. Absence is not a claim; "nothing
   * here yet" is, and it may only be made after a read that came back empty.
   * NEEDS YOU keeps its note because its emptiness is derived from resolved
   * facts (`viewerKnown`, `notificationsError`) rather than from an array. */
  const withRows = (section: HomeSection | null) =>
    section && section.rows.length > 0 ? section : null;
  const needsYouStrip = withRows(work.needsYou);

  /* R4 (2026-08-15): Home IS the chat view. The chat surface — with its
     merged conversation column — fills the canvas and triage rides above it.
     The glance rails, the presence row and the per-kind counts strip retired
     to the Work tab, where the inventory framing lives. */
  return (
    <div
      className="hp-root hp-root--chat"
      data-testid="home-page"
      data-aside={props.aside ? 'open' : undefined}
      data-focus={props.focus ? 'true' : undefined}
    >
      {props.rail ?? null}
      <div className="hp-page">
      <div className="hp-home">
      {/* THE LEFT THIRD. START, then WHAT NEEDS YOU. Nothing else.
       *
       * WHAT WAS HERE AND WHY IT IS GONE (owner, 2026-08-30, on the deployed
       * build): a hero line, a 19-kind census, and WORK / LIBRARY / PEOPLE
       * cards carrying 2358 · 2154 new · 5 live · 458 new · 508 new · 812 new
       * … — nineteen rows of counts for things that merely EXIST.
       *
       *   "why cant it be simplified why are you complicating it … i dont need
       *    make home dashboard clean have one create new chat, New SESSIONS
       *    AND New Task first and their screens while running"
       *
       * THE RAIL IS THE BROWSE. It was restored an hour before this, on the
       * owner's own instruction — "because workspace is already there here" —
       * and the cards were left in place, so the screen stated the same
       * taxonomy TWICE and the duplication the owner had complained about
       * three times got worse rather than better. That was the defect; this
       * removes the half that should have gone with the rail's return.
       *
       * A COUNT OF THINGS THAT EXIST IS NOT PROGRESS. "812 Docs" tells you the
       * database is not empty. Home answers "what is happening and what can I
       * start", and the rail answers "what is there" — one question per
       * surface, which is the whole of the complaint. */}
      <div className="hp-side">
      <HomeStart
        onNewChat={props.onNewChat}
        onCreateKind={props.onCreateKind}
        createKindUnavailable={props.createKindUnavailable}
      />
      {/* NEEDS YOUR ATTENTION follows the verbs: you start something, or you
          deal with what is asking for you. It renders only when it HAS rows —
          `rowsFor` returns [] while a kind is still hydrating, so an empty
          array cannot tell "pending" from "genuinely empty", and a card that
          drew "nothing needs you" off it would assert calm during the window
          where the screen knows nothing. Absence is not a claim; "nothing
          here" is one, and it may only be made after a read that came back
          empty. */}
      {needsYouStrip ? (
        <AttentionCard section={needsYouStrip} onOpen={props.onOpenEntity} />
      ) : work.needsYou && (home.viewerError || home.notificationsError) ? (
        <p className="hp-note" role="status">{work.needsYou.emptyNote}</p>
      ) : null}
      </div>

      {/* THE RIGHT TWO THIRDS: what is happening now. The session list, the
          create verbs and the embedded terminal are the host's (lane H2); this
          column only makes room for them, exactly as the page makes room for
          the aside. The 4/8 ratio IS the brief — "current sessions, current
          chat, anything I created" expressed as screen area. */}
      <section className="hp-live" aria-label="Chat">
        {props.chat}
        {props.listRail ?? null}
      </section>
      </div>
      </div>

      {props.aside ?? null}
    </div>
  );
}
