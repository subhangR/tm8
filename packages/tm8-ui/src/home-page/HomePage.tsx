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
import { HOME_PRESENCE_KIND, HOME_RAIL_KINDS, KindIcon, getKind } from '../domain';
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
  onOpenEntity(id: string): void;
  onOpenKind(kind: string): void;
  onOpenWorkspace(): void;
  /**
   * Per-kind `{ total, unseen }` from `spaces.counts` — the one cheap, real
   * counts read. `undefined` for a kind means THIS SERVER NEVER COUNTED IT,
   * and the chip renders no number (absent ≠ zero). Optional so a host
   * without the read simply shows no counts strip.
   */
  countsFor?: (kind: string) => { total: number; unseen: number } | undefined;
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

  const presenceRows = data.rowsFor(HOME_PRESENCE_KIND)(undefined);
  const workingTeammates = presenceRows.filter(
    (row) => 'liveWork' in row.state && row.state.liveWork,
  ).length;

  /* R4 (2026-08-15): Home IS the chat view. The chat surface — with its
     merged conversation column — fills the canvas; triage rides above it,
     and the foot is one strip of REAL per-kind counts (spaces.counts) with
     the live-session count from the liveness snapshot. The glance rails and
     presence row retired to the Work tab, where the inventory framing lives. */
  return (
    <div className="hp-root hp-root--chat" data-testid="home-page">
      {needsYou && needsYou.rows.length > 0 ? (
        <NeedsYouStrip section={needsYou} onOpen={props.onOpenEntity} />
      ) : needsYou && (home.viewerError || home.notificationsError) ? (
        <p className="hp-note" role="status">{needsYou.emptyNote}</p>
      ) : null}

      <section className="hp-chat hp-chat--full" aria-label="Chat">
        {props.chat}
      </section>

      {props.countsFor ? (
        <footer className="hp-counts" aria-label="Space at a glance" data-testid="hp-counts">
          {[...HOME_RAIL_KINDS, HOME_PRESENCE_KIND].map((kind: string) => {
            const config = getKind(kind);
            const counts = props.countsFor!(kind);
            const live = config.list.liveTreatment ? data.liveIds.length : null;
            const working = kind === HOME_PRESENCE_KIND ? workingTeammates : null;
            return (
              <button
                key={kind}
                type="button"
                className="hp-counts__chip"
                title={
                  counts
                    ? `${counts.total} ${config.labelPlural.toLowerCase()}${counts.unseen > 0 ? `, ${counts.unseen} new to you` : ''}`
                    : `${config.labelPlural} — this server did not report a count`
                }
                onClick={() => props.onOpenKind(kind)}
              >
                <KindIcon kind={kind} />
                <span className="hp-counts__label">{config.labelPlural}</span>
                {/* Absent ≠ zero: no counts read ⇒ no number, never `0`. */}
                {counts ? <span className="hp-counts__total">{counts.total}</span> : null}
                {counts && counts.unseen > 0 ? (
                  <span className="hp-counts__unseen">{counts.unseen} new</span>
                ) : null}
                {live !== null && live > 0 ? (
                  <span className="hp-counts__live">● {live} live</span>
                ) : null}
                {working !== null && working > 0 ? (
                  <span className="hp-counts__live">● {working} working</span>
                ) : null}
              </button>
            );
          })}
        </footer>
      ) : null}
    </div>
  );
}
