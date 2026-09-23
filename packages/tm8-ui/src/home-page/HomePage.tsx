/**
 * HomePage — the merged single home (user ruling, task 01a0027d, 2026-08-14).
 *
 * ONE canvas, two altitudes:
 *
 *   1. NEEDS YOU, only when it has rows — triage outranks everything, and an
 *      inbox-zero space stays quiet.
 *   2. The CHAT remains the full-bleed hero, with main's root list, resizer,
 *      focus mode and beside-it detail column left intact.
 *
 * WHAT IS NO LONGER HERE, AND WHY (Subhang, 2026-09-05). This page used to
 * stack two credential sections between the two altitudes above — the full
 * `CredentialsProviderBlock` and the compact `ProviderRail`. Both are gone.
 *
 * They were wrong in two independent ways. STRUCTURALLY: a card grid is a flex
 * item with `min-height: auto`, so it could not shrink; on any ordinary window
 * the two sections plus the chat exceeded `.hp-page`, and with no `overflow` on
 * the column the grid painted straight over the conversation underneath.
 * EDITORIALLY: they were shown to every member on every visit, finished or not,
 * which is a permanent region of the screen spent on a task that has an end.
 *
 * Credentials now live in exactly two places: `CredentialsSetupDialog` (the
 * guided flow, opened for a member who has not finished) and Settings → Agent
 * credentials (the management surface). Home is the rail, the list and the
 * view — nothing stacked on top of them.
 *
 * WHAT THIS FILE DELIBERATELY REUSES rather than re-implements:
 *   - `useHomeData` / `composeMyWork` (src/home) — the NEEDS YOU composition
 *     with all its honesty rules (viewer-unknown ≠ empty, refused inbox ≠
 *     quiet inbox). This module renders the section; it re-derives nothing.
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

/**
 * Home's narrow read port, and nothing more.
 *
 * It used to widen `seam` with `Pick<Seam, 'credentials'>` for the two
 * credential sections this page hosted. Those are gone, so the widening goes
 * with them: a page that cannot reach the human-only credential operations
 * cannot grow a surface that quietly starts calling them again.
 */
export type HomePageData = HomeScreenData;

export interface HomePageProps {
  data: HomePageData;
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

  /* The full T5-1 composition is reused for NEEDS YOU alone. Main's merged
     chat/list surface owns the collection inventory; Home does not recreate
     the glance rails that moved to Work. */
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
