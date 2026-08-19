/**
 * HELP — the shelf of published Help artifacts, and a reader for one of them.
 *
 * TWO REGIONS on a wide screen: the curated contents on the left, the selected
 * page rendered on the right. ONE region on a phone: the contents, and a page
 * opened over them with a back verb. Same component, same data, one `stacked`
 * flag — a second Help screen for the phone would have been two things to keep
 * true about one shelf.
 *
 * IT ADDS NO ENTITY COMPONENTS, WHICH IS THE STANDING MANDATE ON THIS PROGRAM.
 * The page itself is drawn by `HostedEntityColumn` → `AuxEntityPanel` →
 * `EntityDetailPanel` → the registry's `artifact-preview` block: the exact path
 * that renders an artifact anywhere else in the app, sandboxed frame, revision
 * switcher, TTL re-mint and all. What is new here is the layout and the
 * contents list — a reading order over rows the graph already holds.
 *
 * NO CROSS-PAGE HYPERLINKS ANYWHERE, and this screen is the reason none are
 * needed. Artifact preview URLs are minted per viewer and expire in ~600s, so
 * an `href` written INTO one bundle pointing at another rots to a 404 for
 * everyone but its author, within the hour. Navigation between Help pages is
 * this component's job and is performed by ENTITY ID: pressing a contents row
 * changes `selectedId`, and the column mints that page's own fresh preview.
 *
 * THE EMPTY STATE IS A REAL ANSWER, not a spinner that never resolves. A Space
 * with no `tm8 Help` collection is told exactly that, and told the title it
 * looked for, because the fix is a graph write and the reader (or whoever they
 * ask) can perform it. See `help-set.ts` for why a title is the handle.
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';

import type { EntityId, EntitySummary, SpaceId } from '@tm8/contract';

import type { Seam } from '../data/seam';
import { KIND_ART } from '../domain';
import { PanelResizer, usePanelWidth, VectorIcon } from '../kit';
import { HostedEntityColumn, type HostedColumnBundle } from '../views/hostedEntityColumn';
import { EMPTY_HELP_SET, HELP_COLLECTION_TITLE, loadHelpSet, type HelpSet } from './help-set';
import './help.css';

/** The contents column's default and floor — the app's reading-column numbers. */
const CONTENTS_DEFAULT = 300;
const CONTENTS_MIN = 220;
/** The reader keeps at least this much, so the drag can never erase the page. */
const READER_MIN = 360;
/**
 * The separator track (8px) plus the pane's own 1px border. Nothing in this
 * package sets `box-sizing: border-box` globally, so that border ADDS — copied
 * from `CraftScreen`'s `PANE_CHROME` for exactly the same reason.
 */
const PANE_CHROME = 8 + 1;

export interface HelpScreenProps {
  seam: Seam;
  spaceId: SpaceId;
  /**
   * The shell bundle the reader column is built from. Present ⇒ a selected page
   * renders; absent ⇒ the contents still list and press, and the reader says
   * why it cannot draw rather than showing an empty frame. Optional because the
   * vitest suite and the pixel harnesses mount this screen with no `GateData`.
   */
  panelHost?: HostedColumnBundle;
  /**
   * ONE COLUMN AT A TIME (the phone). The contents are the screen until a page
   * is opened, and the page is the screen until it is closed. Not a media
   * query: the shell already knows which device it is, and a screen that
   * guessed from its own width would disagree with the chrome around it.
   */
  stacked?: boolean;
}

export function HelpScreen({ seam, spaceId, panelHost, stacked = false }: HelpScreenProps) {
  const [set, setSet] = useState<HelpSet>(EMPTY_HELP_SET);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [selectedId, setSelectedId] = useState<EntityId | null>(null);

  const contentsPref = usePanelWidth('help.contents', CONTENTS_DEFAULT, CONTENTS_MIN);

  useEffect(() => {
    let alive = true;
    setPhase('loading');
    loadHelpSet(seam, spaceId).then(
      (next) => {
        if (!alive) return;
        setSet(next);
        setPhase('ready');
        /* THE WIDE SCREEN OPENS ON PAGE ONE; the phone opens on the contents.
           A stacked shell that auto-opened would land a reader inside a page
           they never chose, with the shelf they came for one back-press away. */
        if (!stacked) setSelectedId((current) => current ?? ((next.pages[0]?.id as EntityId | undefined) ?? null));
      },
      () => {
        if (alive) setPhase('error');
      },
    );
    return () => {
      alive = false;
    };
  }, [seam, spaceId, stacked]);

  const selected = useMemo(
    () => set.pages.find((page) => page.id === selectedId) ?? null,
    [set.pages, selectedId],
  );

  const close = useCallback(() => setSelectedId(null), []);

  /* THE CONTENTS, always built — on a wide screen they are a pane, on a phone
     they are the whole screen until a page is opened. */
  const contents = (
    <HelpContents
      pages={set.pages}
      phase={phase}
      selectedId={selectedId}
      onSelect={(id) => setSelectedId(id)}
      stacked={stacked}
    />
  );

  if (stacked) {
    return (
      <div className="hlp-root hlp-root--stacked" data-testid="help-screen" data-stacked="true">
        {selected ? (
          <section className="hlp-reader" aria-label={selected.title}>
            <div className="hlp-reader__head">
              <button
                type="button"
                className="hlp-back"
                data-testid="help-back"
                onClick={close}
                aria-label="Back to Help contents"
              >
                <span aria-hidden>‹</span> Help
              </button>
              <h1 className="hlp-reader__title">{selected.title}</h1>
            </div>
            <HelpReader page={selected} panelHost={panelHost} onOpen={setSelectedId} onClose={close} />
          </section>
        ) : (
          contents
        )}
      </div>
    );
  }

  return (
    <div
      className="hlp-root"
      data-testid="help-screen"
      style={{ '--hlp-contents': `${contentsPref.width}px` } as CSSProperties}
    >
      <nav className="hlp-contents" id="hlp-contents-pane" aria-label="Help contents">
        {contents}
      </nav>
      {/* The floor is the READER's: a handle that could drag the page to
          nothing would be the zero-floored track the layout law forbids. */}
      <PanelResizer
        side="right"
        label="Help contents"
        controls="hlp-contents-pane"
        width={contentsPref.width}
        minWidth={CONTENTS_MIN}
        maxWidth={Math.max(CONTENTS_MIN, contentsPref.width + READER_MIN - PANE_CHROME)}
        onResize={contentsPref.setWidth}
        onReset={contentsPref.reset}
      />
      <section className="hlp-reader" aria-label="Help page" data-testid="help-reader">
        {selected ? (
          <HelpReader page={selected} panelHost={panelHost} onOpen={setSelectedId} onClose={close} />
        ) : (
          <p className="hlp-empty" role="status">
            {phase === 'loading' ? 'Reading the Help shelf…' : 'Pick a page from the contents.'}
          </p>
        )}
      </section>
    </div>
  );
}

/**
 * THE CONTENTS — the curated reading order, numbered.
 *
 * Numbered rather than bulleted because the order is CURATED and means
 * something: these pages build on each other, and a bullet would present five
 * interchangeable links where the graph is asserting a sequence.
 */
function HelpContents({
  pages,
  phase,
  selectedId,
  onSelect,
  stacked,
}: {
  pages: readonly EntitySummary[];
  phase: 'loading' | 'ready' | 'error';
  selectedId: EntityId | null;
  onSelect(id: EntityId): void;
  stacked: boolean;
}) {
  return (
    <div className="hlp-contents__body">
      <h1 className="hlp-contents__head">Help</h1>
      {phase === 'loading' ? (
        <p className="hlp-empty" role="status">
          Reading the Help shelf…
        </p>
      ) : phase === 'error' ? (
        <p className="hlp-empty" data-testid="help-error">
          The Help shelf could not be read from this node. Nothing is missing from the Space — this
          screen simply could not reach it.
        </p>
      ) : pages.length === 0 ? (
        /* NAMES THE FIX. Help is a curated collection in this Space's graph, so
           "there is none" is a statement about the graph and is repairable by
           anyone who can write to it. Saying only "no help yet" would leave a
           reader with nothing to do about it. */
        <p className="hlp-empty" data-testid="help-none">
          This Space has no Help shelf yet. Help is a <code>collection</code> named “
          {HELP_COLLECTION_TITLE}” with <code>contains</code> edges to the pages it holds, in reading
          order — create it and its pages appear here.
        </p>
      ) : (
        <ol className="hlp-list">
          {pages.map((page, index) => {
            const active = !stacked && page.id === selectedId;
            return (
              <li key={page.id}>
                <button
                  type="button"
                  className={`hlp-row ${active ? 'hlp-row--active' : ''}`}
                  data-testid="help-row"
                  aria-current={active ? 'true' : undefined}
                  onClick={() => onSelect(page.id as EntityId)}
                >
                  <span className="hlp-row__n" aria-hidden>
                    {index + 1}
                  </span>
                  <VectorIcon paths={KIND_ART.artifact} className="hlp-row__mark" />
                  <span className="hlp-row__text">
                    <span className="hlp-row__title">{page.title}</span>
                    {page.excerpt ? <span className="hlp-row__excerpt">{page.excerpt}</span> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/**
 * ONE PAGE, drawn by the app's own artifact path.
 *
 * No frame, no viewer and no preview call is written here: `HostedEntityColumn`
 * mounts the shared detail panel, and the registry's `artifact` row already
 * declares the `artifact-preview` block. That is the whole reason this screen
 * needs no new entity components — the render path exists and is the one a
 * reader sees everywhere else.
 */
function HelpReader({
  page,
  panelHost,
  onOpen,
  onClose,
}: {
  page: EntitySummary;
  panelHost: HostedColumnBundle | undefined;
  onOpen(id: EntityId): void;
  onClose(): void;
}) {
  if (!panelHost) {
    /* HONEST ABSENCE, not an empty frame. Without the shell bundle there is no
       detail panel to mount, and saying so beats rendering a blank pane that
       looks like a page that failed to load. */
    return (
      <p className="hlp-empty" data-testid="help-no-host">
        “{page.title}” is on the shelf, but this mount has no shell data behind it, so the page
        cannot be rendered here.
      </p>
    );
  }
  return (
    <div className="hlp-reader__body" data-testid="help-page">
      <HostedEntityColumn
        {...panelHost}
        entityId={page.id as EntityId}
        /* Drilling from inside the page REPLACES the subject — the auxPanel
           law, and the reason no Help page ever needs an outbound href. */
        onOpenEntity={(id) => onOpen(id)}
        onClose={onClose}
      />
    </div>
  );
}
