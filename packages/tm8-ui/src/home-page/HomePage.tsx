/**
 * HomePage — the merged single home (user ruling, task 01a0027d, 2026-08-14).
 *
 * ONE canvas, four altitudes:
 *
 *   1. The CHAT is the hero — the existing chat-home surface, mounted solo
 *      (its thread sidebar hidden by this module's stylesheet; full thread
 *      management stays on the Messages screen).
 *   2. NEEDS YOU directly beneath, only when it has rows — triage outranks
 *      everything, and an inbox-zero space shows rails only.
 *   3. AGENT SIGN-INS — the same live credential block Settings hosts, here
 *      as a first-class management section rather than a link away from Home.
 *   4. Glance RAILS for the daily collections (domain's `HOME_RAIL_KINDS`),
 *      with a compact sign-in strip immediately above Sessions, then teammate
 *      presence and the escape hatch to the full workspace.
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
import { Fragment, useMemo, type ReactNode } from 'react';
import type { EntitySummary } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { HOME_PRESENCE_KIND, HOME_RAIL_KINDS, KindIcon, getKind } from '../domain';
import {
  composeMyWork,
  homeRowOf,
  useHomeData,
  type HomeRow,
  type HomeScreenData,
  type HomeSection,
} from '../home';
import {
  CredentialsProviderBlock,
  credentialsPortFromSeam,
} from '../settings-credentials';
import { ProviderRail } from '../provider-rail';
import './home-page.css';

/** Cards per rail — a glance, not a list. The header opens the whole kind. */
const RAIL_CARD_CAP = 6;

/** Home's existing narrow read port plus the human-only credential operations. */
export type HomePageData = Omit<HomeScreenData, 'seam'> & {
  seam: HomeScreenData['seam'] & Pick<Seam, 'credentials'>;
};

export interface HomePageProps {
  data: HomePageData;
  /** The solo chat surface — the host mounts it (seam wiring is its business). */
  chat: ReactNode;
  onOpenEntity(id: string): void;
  onOpenKind(kind: string): void;
  onOpenWorkspace(): void;
}

const byActivity = (a: EntitySummary, b: EntitySummary): number =>
  b.activityAt.localeCompare(a.activityAt);

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

  return (
    <div className="hp-root" data-testid="home-page">
      <div className="hp-scroll">
        <section className="hp-chat" aria-label="Chat">
          {props.chat}
        </section>

        {/* Triage first, and ONLY when it has rows — an inbox-zero space gets
            a quiet canvas, not an empty amber box. A section empty because a
            READ failed is a different fact and renders its honest note. */}
        {needsYou && needsYou.rows.length > 0 ? (
          <NeedsYouStrip section={needsYou} onOpen={props.onOpenEntity} />
        ) : needsYou && (home.viewerError || home.notificationsError) ? (
          <p className="hp-note" role="status">{needsYou.emptyNote}</p>
        ) : null}

        <section className="hp-credentials" aria-label="Agent sign-ins" data-testid="home-credentials">
          <div className="hp-rail__head">
            <span className="hp-rail__label kit-eyebrow">Agent sign-ins</span>
          </div>
          <CredentialsProviderBlock port={credentialsPort} />
        </section>

        {HOME_RAIL_KINDS.map((kind) => {
          const config = getKind(kind);
          const rows = [...data.rowsFor(kind)(undefined)].sort(byActivity).slice(0, RAIL_CARD_CAP);
          return (
            <Fragment key={kind}>
              {kind === HOME_RAIL_KINDS[1] ? (
                <section
                  className="hp-provider-signins hp-rail"
                  aria-label="Quick provider sign-ins"
                  data-testid="home-provider-rail"
                >
                  <div className="hp-rail__head">
                    <span className="hp-rail__label kit-eyebrow">Sign in to agents</span>
                  </div>
                  <ProviderRail port={credentialsPort} />
                </section>
              ) : null}
              <section className="hp-rail" aria-label={config.labelPlural} data-testid={`hp-rail-${config.slug ?? kind}`}>
                <div className="hp-rail__head">
                  <button type="button" className="hp-rail__open" onClick={() => props.onOpenKind(kind)}>
                    <span className="hp-rail__label kit-eyebrow">{config.labelPlural}</span>
                    <span aria-hidden="true">▸</span>
                  </button>
                </div>
                {rows.length > 0 ? (
                  <div className="hp-rail__scroll">
                    {rows.map((summary) => (
                      <RowCard
                        key={summary.id}
                        row={homeRowOf(summary, {
                          ...(config.list.liveTreatment
                            ? { liveness: data.livenessOf(summary.id) }
                            : {}),
                          streaming: data.activity[summary.id] === true,
                          compact: true,
                        })}
                        onOpen={props.onOpenEntity}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="hp-note">No {config.labelPlural.toLowerCase()} yet.</p>
                )}
              </section>
            </Fragment>
          );
        })}

        {presenceRows.length > 0 ? (
          <section className="hp-presence" aria-label="Teammates" data-testid="hp-presence">
            {presenceRows.map((row) => {
              const liveWork =
                'liveWork' in row.state && row.state.liveWork ? row.state.liveWork : null;
              return (
                <button
                  key={row.id}
                  type="button"
                  className="hp-presence__row"
                  title={liveWork ? `${row.title} — working: ${liveWork.task.title}` : row.title}
                  onClick={() => props.onOpenEntity(row.id)}
                >
                  <span
                    className={`hp-presence__dot ${liveWork ? 'hp-presence__dot--working' : ''}`}
                    aria-hidden="true"
                  />
                  <span className="hp-presence__name">{row.title}</span>
                  {liveWork ? <span className="hp-presence__verb">working</span> : null}
                </button>
              );
            })}
          </section>
        ) : null}

        <footer className="hp-foot">
          <button type="button" className="hp-foot__workspace" onClick={props.onOpenWorkspace}>
            Open full workspace ⌗
          </button>
        </footer>
      </div>
    </div>
  );
}
