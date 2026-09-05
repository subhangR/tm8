/**
 * HomePage — the merged single home (user ruling, task 01a0027d, 2026-08-14).
 *
 * ONE canvas, three altitudes:
 *
 *   1. NEEDS YOU, only when it has rows — triage outranks everything, and an
 *      inbox-zero space stays quiet.
 *   2. AGENT SIGN-INS as ONE LINE, right-aligned above the conversation. This
 *      was previously two stacked sections — the full card grid and a compact
 *      chip strip beneath it — drawn from this same port and measured at
 *      >=425 CSS px before the chat began. The detail now opens on demand.
 *   3. The CHAT remains the full-bleed hero, with main's root list, resizer,
 *      focus mode and beside-it detail column left intact.
 *
 * WHAT THIS FILE DELIBERATELY REUSES rather than re-implements:
 *   - `useHomeData` / `composeMyWork` (src/home) — the NEEDS YOU composition
 *     with all its honesty rules (viewer-unknown ≠ empty, refused inbox ≠
 *     quiet inbox). This module renders the section; it re-derives nothing.
 *   - `CredentialsCorner`, which opens `CredentialsProviderBlock` — the same
 *     component Settings mounts, through the same port adapter. Home still
 *     forks no credential markup and grows no second vocabulary.
 */
import { useMemo, type ReactNode } from 'react';
import type { Seam } from '../data/seam';
import { KindIcon } from '../domain';
import {
  composeMyWork,
  useHomeData,
  type HomeRow,
  type HomeScreenData,
  type HomeSection,
} from '../home';
import { credentialsPortFromSeam } from '../settings-credentials';
import { CredentialsCorner } from '../credentials-corner';
import './home-page.css';

/** Home's existing narrow read port plus the human-only credential operations. */
export type HomePageData = Omit<HomeScreenData, 'seam'> & {
  seam: HomeScreenData['seam'] & Pick<Seam, 'credentials'>;
};

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

  // Home is the host at this boundary. It hands the shared component the same
  // narrow port as Settings, with spaceId bound inside that adapter — never in
  // the component and never by routing around the human-only seam operations.
  const credentialsPort = useMemo(
    () => credentialsPortFromSeam(data.seam, data.spaceId),
    [data.seam, data.spaceId],
  );

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

        {/* One line, right-aligned, above the conversation. It replaces BOTH
            of the stacked credential sections that used to sit here — see the
            header note in CredentialsCorner.tsx for why it states a sentence
            rather than shrinking the marks. */}
        <div className="hp-signins" data-testid="home-credentials">
          <CredentialsCorner port={credentialsPort} />
        </div>

        <section className="hp-chat hp-chat--full" aria-label="Chat">
          {props.chat}
          {props.listRail ?? null}
        </section>
      </div>

      {props.aside ?? null}
    </div>
  );
}
