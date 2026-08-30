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
  summarizeEntityNavigation,
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
}


/* WHICH GROUPS RENDER AS ROWS, AND WHICH AS WRAPPING CHIPS.
 *
 * The target uses two densities deliberately: WORK is a vertical list because
 * its nouns are long, LIBRARY and PEOPLE are wrapping chips because theirs are
 * short. One shape cannot serve both — a long noun in a chip either wraps the
 * chip onto its own line, wasting the density chips exist for, or truncates,
 * which the law forbids.
 *
 * THE BUDGET, with its arithmetic, because a rule without one is how
 * `--tt-actions-reserve` became the worst defect on the screen. The left column
 * is a third of the canvas — about 360px at the narrowest desktop Home reaches,
 * 336px inside the card. Two chips to a line with an 8px gap gives each 164px.
 * A chip spends ~46px on its own chrome (8px padding, a 16px mark, two 6px
 * gaps, 8px padding, 2px border) and up to ~62px on an `N new` pill, leaving
 * ~56px for the noun.
 *
 * ITS MARGIN IS THIN AND THAT IS STATED RATHER THAN HIDDEN: measured last cycle
 * at 5.7px per character, the longest noun in WORK is `Pull requests` (13ch,
 * ~74px) and in LIBRARY it is `Collections` (11ch, ~63px). The threshold
 * separating them is worth about two characters. It is set at 12 so the
 * registry's real data reproduces the target's grouping — the mockup shows only
 * four of LIBRARY's seven kinds, so its own data would not have exercised this.
 * UNMEASURED: the 56px chip budget is arithmetic, not a browser reading. It
 * needs one scheduled run to confirm, and until then this is the number I would
 * check first if the cards look wrong.
 */
const CHIP_NOUN_MAX_CHARS = 12;

function rendersAsRows(group: EntityNavigationGroup): boolean {
  return group.items.some((item) => item.config.labelPlural.length > CHIP_NOUN_MAX_CHARS);
}

/**
 * One entity family as its own card: an eyebrow with the group's totals, the
 * registry's one-line description, then its kinds.
 *
 * THE LAW, unchanged from the surface this replaces: the mark never shrinks,
 * the NAME takes every remaining pixel and ellipses inside them, and the count
 * keeps its own width but never takes the name's. The noun is plain text and
 * the count is its own pill beside it — deliberately NOT one bordered container
 * holding both, which is a different component for a different job.
 */
function GroupCard({
  group,
  activeKind,
  onOpenKind,
}: {
  group: EntityNavigationGroup;
  activeKind?: string | null;
  onOpenKind?(kind: string): void;
}) {
  const rows = rendersAsRows(group);
  return (
    <article
      className="hp-group"
      data-density={rows ? 'rows' : 'chips'}
      aria-labelledby={`hp-group-${group.id}`}
    >
      <div className="hp-group__head">
        <h2 id={`hp-group-${group.id}`} className="hp-group__name">
          {group.label}
        </h2>
        <EntityNavigationMetrics total={group.total} unseen={group.unseen} live={group.live} />
      </div>
      {group.description ? <p className="hp-group__note">{group.description}</p> : null}
      <div className="hp-group__items">
        {group.items.map((item) => (
          <button
            key={item.config.kind}
            type="button"
            className="hp-group__item k-press"
            aria-current={item.config.kind === activeKind ? 'page' : undefined}
            aria-label={entityNavigationLabel(item)}
            title={entityNavigationLabel(item)}
            disabled={!onOpenKind}
            onClick={() => onOpenKind?.(item.config.kind)}
          >
            <span className="hp-group__mark" aria-hidden>
              <KindIcon kind={item.config.kind} />
            </span>
            <span className="hp-group__noun">{item.config.labelPlural}</span>
            {/* `N new` is UNATTENDED WORK, not a quantity — it changes what you
                do next, which is the test colour has to pass. The raw total is
                a quantity and stays ink. Both facts come from the same
                component; the tone is the kit's business, not this card's. */}
            <EntityNavigationMetrics unseen={item.counts?.unseen} live={item.live} />
          </button>
        ))}
      </div>
    </article>
  );
}

/**
 * NEEDS YOUR ATTENTION — a card of rows, each carrying its status word, its
 * title and what it is. The status also paints the row's left edge, so the card
 * can be read as a column of urgencies before any word is read; the WORD is
 * always there too, because status is never colour alone (C8/L10).
 */
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
      {/* THE HERO. It names the space in one line and says how much is in it —
          the sentence the map's header used to carry, back because the 4/8
          split gives the left column its own scroll region and can afford it.
          The count comes from the same summary the cards do; it is never a
          literal. */}
      {props.navigationGroups && props.navigationGroups.length > 0 ? (
        <header className="hp-hero">
          <h1 className="hp-hero__line">Everything connected, one move away</h1>
          <p className="hp-hero__note">
            {summarizeEntityNavigation(props.navigationGroups).kinds} entity types across the work,
            context, and people around you.
          </p>
        </header>
      ) : null}
      <div className="hp-home">
      {/* THE LEFT THIRD: what exists. Its own scroll region, because four cards
          go where one capped card used to be — `.hp-overview` was
          `max-height: 38%` with `overflow: hidden`, which clipped silently with
          no scrollbar and no keyboard path. This column carries
          `overflow-y: auto` and `min-height: 0` so it cannot repeat that. */}
      <div className="hp-side">
      {/* NEEDS YOUR ATTENTION leads the column: triage outranks inventory.
          It renders only when it HAS rows — `rowsFor` returns [] while a kind
          is still hydrating, so an empty array cannot tell "pending" from
          "genuinely empty", and a card that drew "nothing needs you" off it
          would assert calm during the window where the screen knows nothing.
          Absence is not a claim; "nothing here" is one, and it may only be
          made after a read that came back empty. */}
      {needsYouStrip ? (
        <AttentionCard section={needsYouStrip} onOpen={props.onOpenEntity} />
      ) : work.needsYou && (home.viewerError || home.notificationsError) ? (
        <p className="hp-note" role="status">{work.needsYou.emptyNote}</p>
      ) : null}
      {/* THE KIND LIST, ONCE. It lived here and in the rail beside it; the rail
          is gone and these cards are its one home. */}
      {(props.navigationGroups ?? []).map((group) => (
        <GroupCard
          key={group.id}
          group={group}
          activeKind={props.activeKind}
          onOpenKind={props.onOpenKind}
        />
      ))}
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

      {props.aside ?? null}
    </div>
  );
}
