/**
 * HomePage — the merged single home (user ruling, task 01a0027d, 2026-08-14).
 *
 * ONE canvas, four altitudes:
 *
 *   1. The WORKSPACE MAP is compact peripheral vision across every entity
 *      family. It shares the rail's registry-derived model and exact counts.
 *   2. The CHAT is the hero — the existing chat-home surface, mounted solo
 *      (its thread sidebar hidden by this module's stylesheet; full thread
 *      management stays on the Messages screen).
 *   3. NEEDS YOU directly beneath, only when it has rows — triage outranks
 *      everything, and an inbox-zero space shows rails only.
 *   4. The explicit escape hatch to the full Workspace stays visible in the
 *      map header; Home never becomes a capability cul-de-sac.
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
  KindIcon,
  summarizeEntityNavigation,
  type EntityNavigationGroup,
} from '../domain';
import {
  composeMyWork,
  useHomeData,
  type HomeRow,
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

/* WHICH CARDS HAVE A WIDE NOUN — registry data, not a selector list.
 *
 * A map row holds its noun and its count side by side. Measured in the live
 * build (`ui-calm-pass/laneb-budget.mjs`, every count forced visible): a row
 * spends 50px on chrome, the widest ROW count is 56px (`612 · 8 live`), and
 * the widest noun the registry can hand this card is `Interaction profiles` at
 * 114px. So only a card carrying a noun near that width can ever be forced to
 * choose between the two, and only that card should drop its count.
 *
 * The stylesheet cannot ask "how long is this card's longest label", so the
 * card answers in `data-noun` and `home-page.css` queries the answer. Deciding
 * it here — from `labelPlural`, which is registry data — is what keeps the rule
 * from rotting the next time a label changes, and it names no kind (§15.2).
 *
 * The conversion is measured, not assumed: `Interaction profiles` is 20
 * characters and 114px, `Pull requests` is 13 and 74px — 5.7px per character
 * across both. WIDE_NOUN_PX sits between them so that the group carrying the
 * long noun is wide and the busiest group (WORK) is not.
 */
const NOUN_PX_PER_CHAR = 5.7;
const WIDE_NOUN_PX = 100;

function hasWideNoun(group: EntityNavigationGroup): boolean {
  const longest = group.items.reduce(
    (most, item) => Math.max(most, item.config.labelPlural.length),
    0,
  );
  return longest * NOUN_PX_PER_CHAR > WIDE_NOUN_PX;
}

function WorkspaceOverview({
  groups,
  activeKind,
  onOpenKind,
  onOpenWorkspace,
}: {
  groups: readonly EntityNavigationGroup[];
  activeKind?: string | null;
  onOpenKind?(kind: string): void;
  onOpenWorkspace(): void;
}) {
  const summary = summarizeEntityNavigation(groups);

  return (
    <section
      className="hp-overview k-enter"
      aria-labelledby="hp-overview-title"
      data-testid="hp-entity-overview"
    >
      <header className="hp-overview__head">
        {/* One line of chrome, not four. The map's job is the menu of nouns
            beneath it; a headline and a sentence restating what the reader can
            already see were two rows of vertical budget the WORK card needed
            (owner, 2026-08-29: the card was clipped mid-row by the panel's
            bottom edge). "19 entity types" also still reads on the rail mast. */}
        <h2 id="hp-overview-title" className="hp-overview__title">Workspace map</h2>
        <div className="hp-overview__pulse" aria-label="Workspace totals">
          <EntityNavigationMetrics total={summary.total} live={summary.live} density="full" />
          <button
            type="button"
            className="k-btn k-btn--secondary k-btn--sm"
            onClick={onOpenWorkspace}
          >
            Open Workspace <span aria-hidden>→</span>
          </button>
        </div>
      </header>

      <div className="hp-overview__families">
        {groups.map((group) => {
          const groupIsActive = group.items.some((item) => item.config.kind === activeKind);
          return (
            <article
              key={group.id}
              className="hp-overview__family"
              data-active={groupIsActive ? 'true' : undefined}
              /* The card tells the stylesheet how long its longest noun is, so
                 the count budget in `home-page.css` can bind on the ONE card
                 where the noun and the count genuinely compete instead of
                 emptying every card to protect it. See `hasWideNoun`. */
              data-noun={hasWideNoun(group) ? 'wide' : undefined}
              /* The description moves to the hover text: it was a permanently
                 ellipsed line ("Plan, run, and ship the work i…") spending a
                 row of the card's height to say nothing it finished saying. */
              title={group.description}
            >
              <div className="hp-overview__family-head">
                <h3>{group.label}</h3>
                <EntityNavigationMetrics total={group.total} live={group.live} />
              </div>
              <div className="hp-overview__kinds" aria-label={`${group.label} entity types`}>
                {group.items.map((item) => (
                  <button
                    key={item.config.kind}
                    type="button"
                    className="hp-overview__kind k-press"
                    aria-current={item.config.kind === activeKind ? 'page' : undefined}
                    aria-label={entityNavigationLabel(item)}
                    title={entityNavigationLabel(item)}
                    disabled={!onOpenKind}
                    onClick={() => onOpenKind?.(item.config.kind)}
                  >
                    <span className="hp-overview__kind-mark" aria-hidden>
                      <KindIcon kind={item.config.kind} />
                    </span>
                    <span className="hp-overview__kind-name">{item.config.labelPlural}</span>
                    {/* ONE number per row. The unseen pill is deliberately not
                        passed: a row carrying both a total and an "N new" chip
                        is what squeezed these nouns down to `Tas…`, `Do…`,
                        `Pul…`, and "2078 new out of 2283" was never the fact
                        the reader wanted (owner ruling, 2026-08-29). The exact
                        unseen count still reads in the button's accessible name
                        and hover text via `entityNavigationLabel`. */}
                    <EntityNavigationMetrics total={item.counts?.total} live={item.live} />
                  </button>
                ))}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function RowCard({ row, onOpen }: { row: HomeRow; onOpen(id: string): void }) {
  return (
    <button
      type="button"
      className="hp-card"
      title={row.detail ?? row.title}
      onClick={() => onOpen(row.id)}
    >
      <span className="hp-card__head">
        {row.kind ? (
          <span className="hp-card__glyph" aria-hidden="true">
            <KindIcon kind={row.kind} />
          </span>
        ) : null}
        {row.word ? (
          <span className={`hp-card__word hp-card__word--${row.tone}`}>
            {row.dot ? <span className={`hp-card__dot hp-card__dot--${row.dot}`} aria-hidden="true" /> : null}
            {row.word}
          </span>
        ) : null}
      </span>
      <span className="hp-card__title">{row.title}</span>
    </button>
  );
}

/**
 * One composed section, drawn as the strip Home already uses for NEEDS YOU.
 *
 * It was `NeedsYouStrip` and it only ever differed from the others by a class
 * name — `composeMyWork` hands every section the same shape, so one component
 * draws all of them. The variant carries the tone (NEEDS YOU keeps its amber
 * border) and the test id; nothing else changes per section.
 */
function SectionStrip({
  section,
  variant,
  testId,
  onOpen,
}: {
  section: HomeSection;
  variant: string;
  testId: string;
  onOpen(id: string): void;
}) {
  return (
    <section className={`hp-strip ${variant}`} aria-label={section.label} data-testid={testId}>
      <div className="hp-rail__head">
        <span className="hp-rail__label kit-eyebrow">
          {section.label} · {section.rows.length}
        </span>
      </div>
      <div className="hp-rail__scroll">
        {section.rows.map((row) => (
          <RowCard key={row.id} row={row} onOpen={onOpen} />
        ))}
      </div>
    </section>
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
    const by = (id: string) => work.sections.find((section) => section.id === id) ?? null;
    return {
      needsYou: work.sections.find((section) => section.emphasis === 'needs-you') ?? null,
      live: by('live'),
      tasks: by('tasks'),
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
  const liveStrip = withRows(work.live);
  const needsYouStrip = withRows(work.needsYou);
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
      {props.navigationGroups && props.navigationGroups.length > 0 ? (
        <WorkspaceOverview
          groups={props.navigationGroups}
          activeKind={props.activeKind}
          onOpenKind={props.onOpenKind}
          onOpenWorkspace={props.onOpenWorkspace}
        />
      ) : null}
      {/* LIVE first: the dashboard's top line is what is happening right now.
          Its rows carry the seam's verdict, so a session the node cannot
          account for reads `stale` here rather than claiming to run. */}
      {liveStrip ? (
        <SectionStrip
          section={liveStrip}
          variant="hp-strip--live"
          testId="hp-live-sessions"
          onOpen={props.onOpenEntity}
        />
      ) : null}
      {needsYouStrip ? (
        <SectionStrip
          section={needsYouStrip}
          variant="hp-needs"
          testId="hp-needs-you"
          onOpen={props.onOpenEntity}
        />
      ) : work.needsYou && (home.viewerError || home.notificationsError) ? (
        <p className="hp-note" role="status">{work.needsYou.emptyNote}</p>
      ) : null}
      {tasksStrip ? (
        <SectionStrip
          section={tasksStrip}
          variant="hp-strip--mine"
          testId="hp-my-tasks"
          onOpen={props.onOpenEntity}
        />
      ) : null}

      <section className="hp-chat hp-chat--full" aria-label="Chat">
        {props.chat}
        {props.listRail ?? null}
      </section>
      </div>

      {props.aside ?? null}
    </div>
  );
}
