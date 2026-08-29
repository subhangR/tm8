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
      className="hp-overview k-hero k-accent-top k-enter"
      aria-labelledby="hp-overview-title"
      data-testid="hp-entity-overview"
    >
      <header className="hp-overview__head">
        <div className="hp-overview__copy">
          <span className="k-label">Workspace map</span>
          <h2 id="hp-overview-title">Everything connected, one move away</h2>
          <p>{summary.kinds} entity types across the work, context, and people around you.</p>
        </div>
        <div className="hp-overview__pulse" aria-label="Workspace totals">
          <EntityNavigationMetrics
            total={summary.total}
            unseen={summary.unseen}
            live={summary.live}
            density="full"
          />
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
            >
              <div className="hp-overview__family-head">
                <div>
                  <h3>{group.label}</h3>
                  <p>{group.description}</p>
                </div>
                <EntityNavigationMetrics
                  total={group.total}
                  unseen={group.unseen}
                  live={group.live}
                />
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
                    <EntityNavigationMetrics
                      total={item.counts?.total}
                      unseen={item.counts?.unseen}
                      live={item.live}
                    />
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

function NeedsYouStrip({ section, onOpen }: { section: HomeSection; onOpen(id: string): void }) {
  return (
    <section className="hp-needs" aria-label={section.label} data-testid="hp-needs-you">
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

  /* The full T5-1 composition, reused for its NEEDS YOU section alone — the
     other sections' facts render as rails below, where the whole space (not
     just "mine") is the design. */
  const needsYou = useMemo(() => {
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
    return work.sections.find((section) => section.emphasis === 'needs-you') ?? null;
  }, [home, data.livenessOf, data.activity]);

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
      {needsYou && needsYou.rows.length > 0 ? (
        <NeedsYouStrip section={needsYou} onOpen={props.onOpenEntity} />
      ) : needsYou && (home.viewerError || home.notificationsError) ? (
        <p className="hp-note" role="status">{needsYou.emptyNote}</p>
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
