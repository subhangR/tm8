/**
 * HELP — a graph-driven field guide and the shared artifact reader.
 *
 * Artifact ids never appear here. The Space's `tm8 Help` collection chooses
 * the pages; ordered `contains` edges choose their chapter and sequence. The
 * shell provides the editorial map around that graph truth and hands the page
 * itself to `HostedEntityColumn`, preserving the app's existing sandboxed
 * artifact-preview path, revision switcher and expiring-preview refresh.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';

import type { EntityId, SpaceId } from '@tm8/contract';

import type { Seam } from '../data/seam';
import { PanelResizer, VectorIcon, usePanelWidth } from '../kit';
import { KIND_ART } from '../domain';
import { HostedEntityColumn, type HostedColumnBundle } from '../views/hostedEntityColumn';
import {
  EMPTY_HELP_SET,
  HELP_COLLECTION_TITLE,
  loadHelpSet,
  type HelpChapter,
  type HelpPage,
  type HelpSet,
} from './help-set';
import './help.css';

const CONTENTS_DEFAULT = 376;
const CONTENTS_MIN = 280;
const READER_MIN = 420;
const PANE_CHROME = 8 + 1;

export interface HelpScreenProps {
  seam: Seam;
  spaceId: SpaceId;
  panelHost?: HostedColumnBundle;
  /** On a phone, the shelf and the selected page occupy one surface each. */
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
        if (!stacked) setSelectedId((current) => current ?? next.pages[0]?.id ?? null);
      },
      () => {
        if (alive) setPhase('error');
      },
    );
    return () => {
      alive = false;
    };
  }, [seam, spaceId, stacked]);

  const selectedIndex = useMemo(
    () => set.pages.findIndex((page) => page.id === selectedId),
    [set.pages, selectedId],
  );
  const selected = selectedIndex >= 0 ? set.pages[selectedIndex] ?? null : null;
  const selectedChapter = selected
    ? set.chapters.find((chapter) => chapter.id === selected.sectionId) ?? null
    : null;
  const close = useCallback(() => setSelectedId(null), []);
  const selectRelative = useCallback(
    (delta: number) => {
      if (selectedIndex < 0) return;
      const next = set.pages[selectedIndex + delta];
      if (next) setSelectedId(next.id);
    },
    [selectedIndex, set.pages],
  );

  const contents = (
    <HelpContents
      set={set}
      phase={phase}
      selectedId={selectedId}
      onSelect={setSelectedId}
      stacked={stacked}
    />
  );

  if (stacked) {
    return (
      <div className="hlp-root hlp-root--stacked" data-testid="help-screen" data-stacked="true">
        {selected && selectedChapter ? (
          <section className="hlp-reader" aria-labelledby="hlp-reader-title">
            <ReaderHeader
              page={selected}
              chapter={selectedChapter}
              pageCount={set.pages.length}
              stacked
              onBack={close}
              onPrevious={selectedIndex > 0 ? () => selectRelative(-1) : undefined}
              onNext={selectedIndex < set.pages.length - 1 ? () => selectRelative(1) : undefined}
            />
            <HelpReader page={selected} panelHost={panelHost} onOpen={setSelectedId} onClose={close} />
          </section>
        ) : (
          <nav className="hlp-contents" aria-label="Help contents">{contents}</nav>
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
      <nav className="hlp-contents" id="hlp-contents-pane" aria-label="Help contents">{contents}</nav>
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
      <section
        className="hlp-reader"
        aria-labelledby={selected ? 'hlp-reader-title' : undefined}
        aria-label={selected ? undefined : 'Help page'}
        data-testid="help-reader"
      >
        {selected && selectedChapter ? (
          <>
            <ReaderHeader
              page={selected}
              chapter={selectedChapter}
              pageCount={set.pages.length}
              onPrevious={selectedIndex > 0 ? () => selectRelative(-1) : undefined}
              onNext={selectedIndex < set.pages.length - 1 ? () => selectRelative(1) : undefined}
            />
            <HelpReader page={selected} panelHost={panelHost} onOpen={setSelectedId} onClose={close} />
          </>
        ) : (
          <p className="hlp-empty" role="status">
            {phase === 'loading' ? 'Reading the Help library…' : 'Choose a plate from the contents.'}
          </p>
        )}
      </section>
    </div>
  );
}

function HelpContents({ set, phase, selectedId, onSelect, stacked }: {
  set: HelpSet;
  phase: 'loading' | 'ready' | 'error';
  selectedId: EntityId | null;
  onSelect(id: EntityId): void;
  stacked: boolean;
}) {
  const openChapters = set.chapters.filter((chapter) => chapter.pages.length > 0).length;
  return (
    <div className="hlp-contents__body">
      <header className="hlp-masthead">
        <div className="hlp-masthead__kicker"><span>tm8</span><span aria-hidden>◆</span><span>Field guide</span></div>
        <h1 className="hlp-masthead__title">Help</h1>
        <p className="hlp-masthead__lede">A practical library for understanding the graph, finding your footing, and working well together.</p>
        {phase === 'ready' && set.pages.length > 0 ? (
          <p className="hlp-masthead__measure" aria-label={`${set.pages.length} pages across ${openChapters} populated chapters`}>
            {set.pages.length} {set.pages.length === 1 ? 'plate' : 'plates'} <span aria-hidden>·</span> {openChapters} {openChapters === 1 ? 'chapter' : 'chapters'} open
          </p>
        ) : null}
      </header>

      {phase === 'loading' ? (
        <p className="hlp-empty" role="status">Reading the Help library…</p>
      ) : phase === 'error' ? (
        <p className="hlp-empty" data-testid="help-error">
          The Help library could not be read from this node. Nothing is missing from the Space — this screen simply could not reach it.
        </p>
      ) : set.pages.length === 0 ? (
        <p className="hlp-empty" data-testid="help-none">
          This Space has no Help library yet. Help is a <code>collection</code> named “{HELP_COLLECTION_TITLE}” with ordered <code>contains</code> edges to its published plates.
        </p>
      ) : (
        <>
          <ChapterMap chapters={set.chapters} />
          <div className="hlp-library" data-testid="help-library">
            {set.chapters.filter((chapter) => chapter.pages.length > 0).map((chapter) => (
              <HelpChapterSection
                key={chapter.id}
                chapter={chapter}
                selectedId={selectedId}
                onSelect={onSelect}
                stacked={stacked}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ChapterMap({ chapters }: { chapters: readonly HelpChapter[] }) {
  return (
    <section className="hlp-map" aria-labelledby="hlp-map-title">
      <div className="hlp-rule"><span id="hlp-map-title">Reading map</span></div>
      <ol className="hlp-map__list">
        {chapters.filter((chapter) => chapter.id !== 'unfiled').map((chapter) => (
          <li
            key={chapter.id}
            className={chapter.pages.length > 0 ? 'hlp-map__item hlp-map__item--open' : 'hlp-map__item'}
            title={chapter.title}
          >
            <span>{chapter.number}</span>
            <span className="hlp-sr-only">
              {chapter.title}: {chapter.pages.length} {chapter.pages.length === 1 ? 'page' : 'pages'}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function HelpChapterSection({ chapter, selectedId, onSelect, stacked }: {
  chapter: HelpChapter;
  selectedId: EntityId | null;
  onSelect(id: EntityId): void;
  stacked: boolean;
}) {
  const headingId = `hlp-chapter-${chapter.id}`;
  return (
    <section className="hlp-chapter" aria-labelledby={headingId} data-testid="help-chapter" data-section={chapter.id}>
      <header className="hlp-chapter__head">
        <span className="hlp-chapter__number" aria-hidden>{chapter.number}</span>
        <span className="hlp-chapter__words">
          <span className="hlp-chapter__eyebrow">{chapter.eyebrow}</span>
          <h2 id={headingId} className="hlp-chapter__title">{chapter.title}</h2>
        </span>
        <span className="hlp-chapter__count" aria-label={`${chapter.pages.length} pages`}>{chapter.pages.length}</span>
      </header>
      <p className="hlp-chapter__summary">{chapter.summary}</p>
      <ol className="hlp-list">
        {chapter.pages.map((page) => {
          const active = !stacked && page.id === selectedId;
          return (
            <li key={page.id}>
              <button
                type="button"
                className={`hlp-row ${active ? 'hlp-row--active' : ''}`}
                data-testid="help-row"
                data-help-page
                aria-current={active ? 'page' : undefined}
                onClick={() => onSelect(page.id)}
                onKeyDown={moveHelpFocus}
              >
                <span className="hlp-row__n" aria-hidden>{String(page.sequence).padStart(2, '0')}</span>
                <VectorIcon paths={KIND_ART.artifact} className="hlp-row__mark" />
                <span className="hlp-row__text">
                  <span className="hlp-row__title">{page.title}</span>
                  {page.excerpt ? <span className="hlp-row__excerpt">{page.excerpt}</span> : null}
                </span>
                <span className="hlp-row__arrow" aria-hidden>→</span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Arrow keys traverse the whole reading order while Tab remains ordinary. */
function moveHelpFocus(event: KeyboardEvent<HTMLButtonElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const root = event.currentTarget.closest('.hlp-contents__body');
  const rows = Array.from(root?.querySelectorAll<HTMLButtonElement>('[data-help-page]') ?? []);
  const current = rows.indexOf(event.currentTarget);
  if (current < 0 || rows.length === 0) return;
  event.preventDefault();
  const next = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? rows.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
  rows[next]?.focus();
}

function ReaderHeader({ page, chapter, pageCount, stacked = false, onBack, onPrevious, onNext }: {
  page: HelpPage;
  chapter: HelpChapter;
  pageCount: number;
  stacked?: boolean;
  onBack?: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  return (
    <header className="hlp-reader__head">
      {stacked ? (
        <button type="button" className="hlp-back" data-testid="help-back" onClick={onBack} aria-label="Back to Help contents">
          <span aria-hidden>‹</span><span>Contents</span>
        </button>
      ) : null}
      <div className="hlp-reader__identity">
        <p className="hlp-reader__crumb"><span>Section {chapter.number}</span><span aria-hidden>◆</span><span>{chapter.title}</span></p>
        <h1 id="hlp-reader-title" className="hlp-reader__title">{page.title}</h1>
        <p className="hlp-reader__progress">Plate {page.sequence} of {pageCount}</p>
      </div>
      <div className="hlp-reader__steps" aria-label="Page navigation">
        <button type="button" className="hlp-step" disabled={!onPrevious} onClick={onPrevious} aria-label="Previous Help page"><span aria-hidden>←</span></button>
        <button type="button" className="hlp-step" disabled={!onNext} onClick={onNext} aria-label="Next Help page"><span aria-hidden>→</span></button>
      </div>
      <div className="hlp-progress-track" aria-hidden><span style={{ width: `${(page.sequence / pageCount) * 100}%` }} /></div>
    </header>
  );
}

function HelpReader({ page, panelHost, onOpen, onClose }: {
  page: HelpPage;
  panelHost: HostedColumnBundle | undefined;
  onOpen(id: EntityId): void;
  onClose(): void;
}) {
  if (!panelHost) {
    return (
      <p className="hlp-empty" data-testid="help-no-host">
        “{page.title}” is in the library, but this mount has no shell data behind it, so the plate cannot be rendered here.
      </p>
    );
  }
  return (
    <div className="hlp-reader__body" data-testid="help-page">
      <HostedEntityColumn {...panelHost} entityId={page.id} onOpenEntity={onOpen} onClose={onClose} />
    </div>
  );
}
