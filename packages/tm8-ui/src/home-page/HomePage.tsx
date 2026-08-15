/**
 * HomePage — the merged single home (user ruling, task 01a0027d, 2026-08-14).
 *
 * ONE canvas, three altitudes:
 *
 *   1. The CHAT is the hero — the existing chat-home surface, mounted solo
 *      (its thread sidebar hidden by this module's stylesheet; full thread
 *      management stays on the Messages screen).
 *   2. NEEDS YOU directly beneath, only when it has rows — triage outranks
 *      everything, and an inbox-zero space shows rails only.
 *   3. Glance RAILS for the daily collections (domain's `HOME_RAIL_KINDS`),
 *      a teammate presence row, and the escape hatch to the full workspace.
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
import { KindIcon } from '../domain';
import {
  composeMyWork,
  useHomeData,
  type HomeRow,
  type HomeScreenData,
  type HomeSection,
} from '../home';
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
  onOpenEntity(id: string): void;
  onOpenWorkspace(): void;
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
    <div className="hp-root hp-root--chat" data-testid="home-page" data-aside={props.aside ? 'open' : undefined}>
      <div className="hp-page">
      {needsYou && needsYou.rows.length > 0 ? (
        <NeedsYouStrip section={needsYou} onOpen={props.onOpenEntity} />
      ) : needsYou && (home.viewerError || home.notificationsError) ? (
        <p className="hp-note" role="status">{needsYou.emptyNote}</p>
      ) : null}

      <section className="hp-chat hp-chat--full" aria-label="Chat">
        {props.chat}
      </section>
      </div>

      {props.aside ?? null}
    </div>
  );
}
