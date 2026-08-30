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
import { useMemo, useState, type ReactNode } from 'react';
import {
  entityNavigationLabel,
  getKind,
  KindIcon,
  type EntityNavigationGroup,
} from '../domain';
import {
  composeMyWork,
  type ChatThreadLite,
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
  onCreateKind,
  createKindUnavailable,
}: {
  onCreateKind?: ((kind: string) => void) | undefined;
  createKindUnavailable?: ((kind: string) => { cause: string; remedy: string } | null) | undefined;
}) {
  /* A verb whose handler is absent is not rendered at all — that is a host
     that never wired it, which is different from a host that wired it and the
     server refused. The second gets a disabled control with its reason; the
     first would be a button we invented. */
  const kindVerb = (kind: string, label: string, blurb: string) => {
    if (!onCreateKind) return null;
    const refusal = createKindUnavailable?.(kind) ?? null;
    if (refusal) {
      return (
        <span className="hp-start__card hp-start__card--off" title={`${refusal.cause} — ${refusal.remedy}`}>
          <b>{label}</b>
          <span>{refusal.cause}</span>
        </span>
      );
    }
    return (
      <button type="button" className="hp-start__card" onClick={() => onCreateKind(kind)}>
        <b>{label}</b>
        <span>{blurb}</span>
      </button>
    );
  };

  /* NEW CHAT IS DELIBERATELY ABSENT, and this is the one place this row
   * departs from the owner's literal words ("one create new chat, New SESSIONS
   * AND New Task first").
   *
   * The chat surface ALREADY owns that verb — `ListRootHeader` renders a `+`
   * labelled "New chat" beside the Chats tab, two inches from here, on this
   * same screen. Adding a second one made the gate fail with
   *
   *   Found multiple elements with the role "button" and name /^New chat$/
   *
   * which is exactly what `HomeCreateVerbs`' own docblock predicted: "Two
   * controls for one verb is how 'options repeating' comes back, which is the
   * complaint the dashboard exists to answer." I quoted that rule and then
   * broke it in the same change.
   *
   * Removing the OTHER control was the alternative and it is the riskier half:
   * seven assertions across three files defend it, one of them the subtle
   * "a new conversation is not stolen" case.
   *
   * SO THIS IS THE OWNER'S CALL, NOT A SETTLED DESIGN. If they want all three
   * verbs together, the `+` moves into this row and those tests move with it.
   * What is not on the table is shipping two buttons that say "New chat". */
  const session = kindVerb('session', 'New session', 'Put an agent on it and watch it work');
  const task = kindVerb('task', 'New task', 'Track a piece of work to done');

  /* Nothing wired ⇒ no row, rather than an empty box asserting "you can start
     things" and offering none. */
  if (!session && !task) return null;

  return (
    <section className="hp-start" aria-label="Start something">
      {session}
      {task}
    </section>
  );
}


/**
 * "2m" / "3h" / "5d" — the shortest true form.
 *
 * NO "just now" AND NO ROUNDING UP. A session stamped four minutes ago reads
 * `4m`, not `just now`, because the whole point of this line is telling a
 * stalled session from a live one at a glance. Anything under a minute is the
 * only case where a word beats a number, and it says `now` rather than `0m`.
 *
 * An unparseable stamp renders NOTHING rather than `NaN` or a guess.
 */
function sinceLabel(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}


/** The four lenses on the active strip. `all` is the resting state. */
type ActiveLens = 'all' | 'chats' | 'sessions' | 'tasks';

/**
 * ONE LIST OF WHAT IS HAPPENING — sessions, chats and tasks together, because
 * the owner asked for exactly that ("Running sessions chats all active works
 * across all these is filter by chats active sessions active task active").
 *
 * THE LENS FILTERS; IT DOES NOT FETCH. Every row is already on the page, so
 * switching lens cannot fail, cannot spin, and cannot show a different truth
 * than `all` did a moment earlier. A filter that re-reads is a second source
 * of truth wearing a chip.
 */
function activeRows(
  live: HomeSection | null,
  tasks: HomeSection | null,
  chats: readonly ChatThreadLite[] | null,
  lens: ActiveLens,
): readonly (HomeRow & { lens: ActiveLens })[] {
  const s = (live?.rows ?? []).map((r) => ({ ...r, lens: 'sessions' as const }));
  const t = (tasks?.rows ?? []).map((r) => ({ ...r, lens: 'tasks' as const }));
  /* Chats arrive from the seam rather than the registry, so they are shaped
     here into the same row the other two already are — one row type, one card,
     one renderer. A second card shape per source is how a list stops looking
     like a list. */
  const c = (chats ?? []).map((thread) => ({
    id: thread.id,
    kind: null,
    title: thread.title?.trim() || 'Untitled conversation',
    word: null,
    tone: 'idle' as const,
    dot: null,
    ...(thread.activityAt ? { activityAt: thread.activityAt } : {}),
    ...(typeof thread.messageCount === 'number' && thread.messageCount > 0
      ? { turns: thread.messageCount }
      : {}),
    lens: 'chats' as const,
  }));
  const all = [...s, ...c, ...t];
  const picked = lens === 'all' ? all : all.filter((r) => r.lens === lens);
  /* Most recently active first, across all three kinds — the only ordering
     that answers "what is happening" rather than "what kind is it". */
  return [...picked].sort((a, b) => (b.activityAt ?? '').localeCompare(a.activityAt ?? ''));
}


const LENSES: readonly { id: ActiveLens; label: string }[] = [
  { id: 'all', label: 'all' },
  { id: 'chats', label: 'chats' },
  { id: 'sessions', label: 'sessions' },
  { id: 'tasks', label: 'tasks' },
];

/**
 * ACTIVE — the whole dashboard, in one strip.
 *
 * ORDERED BY ACTIVITY, NOT BY KIND (owner: "have everything modified based on
 * date activity and progress"). The newest thing is first whether it is a
 * session, a chat or a task, because "what is happening" is a question about
 * time and the kind is a detail of the answer.
 *
 * COLOUR CARRIES THE KIND, LIGHTLY. Each card takes a soft tint of its kind's
 * tone — the tokens the rest of the app already uses for run/wait/info — so
 * three kinds are legible in one list without a second row of labels. The tint
 * is the SOFT variant, never the full tone: a full-strength ground behind body
 * text is a badge, not a card, and this list is read rather than scanned for
 * alarm. Status still carries its WORD; the colour never stands alone (C8/L10).
 */
function ActiveStrip({
  rows,
  lens,
  onLens,
  liveLabel,
  onOpen,
}: {
  rows: readonly (HomeRow & { lens: ActiveLens })[];
  lens: ActiveLens;
  onLens(next: ActiveLens): void;
  liveLabel: string;
  onOpen(id: string): void;
}) {
  return (
    <section className="hp-active" aria-label="Active work">
      <div className="hp-active__bar">
        <h2 className="hp-active__label k-label">Active</h2>
        <div className="hp-active__lenses" role="tablist" aria-label="Filter active work">
          {LENSES.map((l) => (
            <button
              key={l.id}
              type="button"
              role="tab"
              aria-selected={l.id === lens}
              className={`hp-lens${l.id === lens ? ' hp-lens--on' : ''}`}
              onClick={() => onLens(l.id)}
            >
              {l.label}
            </button>
          ))}
        </div>
        <span className="hp-active__live">{liveLabel}</span>
      </div>
      {rows.length === 0 ? (
        /* A LENS THAT MATCHES NOTHING SAYS SO. This is not the "absence is not
           a claim" case — the reader chose this lens, so silence would read as
           a broken filter rather than an empty one. */
        <p className="hp-active__none" role="status">
          Nothing active {lens === 'all' ? 'right now' : `in ${lens}`}.
        </p>
      ) : (
        <div className="hp-active__grid">
          {rows.map((row) => (
            <button
              key={`${row.lens}-${row.id}`}
              type="button"
              className={`hp-acard hp-acard--${row.lens} k-press`}
              title={row.detail ?? row.title}
              onClick={() => onOpen(row.id)}
            >
              <span className="hp-acard__top">
                <span className="hp-acard__kind">{row.lens.replace(/s$/, '')}</span>
                {row.word ? (
                  <span className={`hp-card__word hp-card__word--${row.tone}`}>
                    {row.dot ? (
                      <span className={`hp-card__dot hp-card__dot--${row.dot}`} aria-hidden="true" />
                    ) : null}
                    {row.word}
                  </span>
                ) : null}
              </span>
              <span className="hp-acard__title">{row.title}</span>
              <span className="hp-acard__facts">
                {row.turns !== undefined ? (
                  <span>{row.turns} {row.turns === 1 ? 'turn' : 'turns'}</span>
                ) : null}
                {row.activityAt ? (
                  <time dateTime={row.activityAt}>{sinceLabel(row.activityAt)}</time>
                ) : null}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function AttentionCard({
  section,
  onOpen,
  count,
  showKind = false,
}: {
  section: HomeSection;
  onOpen(id: string): void;
  /** A live tally, when the section has one. Absent ⇒ no number is claimed. */
  count?: string | undefined;
  /** Only where the strip MIXES kinds. A heading that names the kind already
      said it, and saying it twice is the repetition this screen is for. */
  showKind?: boolean;
}) {
  return (
    <article className="hp-attention" aria-label={section.label} data-testid="hp-needs-you">
      <div className="hp-attention__head">
        <h2 className="hp-attention__eyebrow k-label">{section.label}</h2>
        {count ? <span className="hp-attention__count">{count}</span> : null}
      </div>
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
            {/* PROGRESS AND ACTIVITY (owner, 2026-08-30) — the two facts the
                node actually stamps. Each renders only when present: a card
                that draws "0 turns" or "never" states something false about a
                session whose counters have not arrived yet. */}
            {row.turns !== undefined || row.activityAt ? (
              <span className="hp-attention__facts">
                {row.turns !== undefined ? (
                  <span className="hp-attention__turns">
                    {/* One turn is a turn. The plural bug was visible in the
                        first render of this card and nowhere in 4,974 tests —
                        no assertion reads the rendered string. */}
                    {row.turns} {row.turns === 1 ? 'turn' : 'turns'}
                  </span>
                ) : null}
                {row.activityAt ? (
                  <time className="hp-attention__when" dateTime={row.activityAt}>
                    {sinceLabel(row.activityAt)}
                  </time>
                ) : null}
              </span>
            ) : null}
            {/* THE KIND LINE IS GONE FROM THE STRIPS THAT NAME THEIR KIND.
                "Session" under a heading reading MY LIVE SESSIONS, on all five
                rows, is the repetition the owner has objected to four times —
                and it was five lines of it in the first render.

                `showKind` keeps it for NEEDS YOU, which genuinely mixes kinds:
                a row there can be a task, a session or a pull request, and
                without the mark the reader cannot tell which. One heading, one
                statement of the kind — either the heading says it or the row
                does, never both. */}
            {showKind && row.kind ? (
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
    const byId = (id: string) => work.sections.find((section) => section.id === id) ?? null;
    return {
      needsYou: work.sections.find((section) => section.emphasis === 'needs-you') ?? null,
      /* "i just need chats taks and session srunning in the dashboard" —
         these two were composed and discarded on every render. */
      live: byId('live'),
      tasks: byId('tasks'),
      liveCount: work.liveCount,
      liveCountLabel: work.liveCountLabel,
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
  const [lens, setLens] = useState<ActiveLens>('all');
  const needsYouStrip = withRows(work.needsYou);
  const liveStrip = withRows(work.live);
  const tasksStrip = withRows(work.tasks);

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
        onCreateKind={props.onCreateKind}
        createKindUnavailable={props.createKindUnavailable}
      />
      {/* THE ACTIVE STRIP — sessions, chats and tasks in ONE list, with a lens.
          Owner, 2026-08-30, choosing a mix of layouts 3 and 4: the work reads
          as wide cards, and the conversation keeps a permanent home beneath
          them. That mix is better than either alone — 03 had nowhere for a
          conversation to live, so opening one covered the dashboard. */}
      <ActiveStrip
        rows={activeRows(work.live, work.tasks, home.chatThreads, lens)}
        lens={lens}
        onLens={setLens}
        liveLabel={work.liveCountLabel}
        onOpen={props.onOpenEntity}
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
        <AttentionCard section={needsYouStrip} onOpen={props.onOpenEntity} showKind />
      ) : work.needsYou && (home.viewerError || home.notificationsError) ? (
        <p className="hp-note" role="status">{work.needsYou.emptyNote}</p>
      ) : null}
      {/* RUNNING SESSIONS, then TASKS. Both were already composed and thrown
          away; this renders them. A row opens the entity BESIDE this column —
          the same gesture as a NEEDS YOU row — which is "their screens while
          running": the session's own screen, in the detail region, without
          leaving Home. */}
      {liveStrip ? (
        <AttentionCard
          section={liveStrip}
          onOpen={props.onOpenEntity}
          count={work.liveCountLabel}
        />
      ) : null}
      {tasksStrip ? (
        <AttentionCard section={tasksStrip} onOpen={props.onOpenEntity} />
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
