/**
 * HELP — the field guide, and the reader that opens its plates.
 *
 * THE LIBRARY IS STATIC (owner ruling, 2026-08-20). `HELP_SET` is built from
 * `help-plates.ts` at module scope, so this screen has all 55 plates on its
 * first paint with no seam, no fetch, no loading state and no way for an
 * unreachable graph to leave a reader without a manual. The plate itself is a
 * vendored artifact bundle in a sandboxed frame — see `HelpPlate.tsx` for why
 * that is the port, and why it is safe.
 *
 * WHICH PLATE IS OPEN IS THE URL'S. `navStore` holds it as `view.plate`, so a
 * plate is linkable, reloadable and Back-able: every open is a history push,
 * which makes the browser's Back button the reader's "previous page" and makes
 * a Help link something you can send someone. The one route this screen writes
 * with `replace` is the desktop landing — see the effect below.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';

import { PanelResizer, VectorIcon, usePanelWidth } from '../kit';
import { KIND_ART } from '../domain';
import { navStore, useNavStore } from '../stores/navStore';
import { HelpPlate } from './HelpPlate';
import { HELP_SET, type HelpChapter, type HelpPage, type HelpSet } from './help-set';
import './help.css';

const CONTENTS_DEFAULT = 376;
const CONTENTS_MIN = 280;
const READER_MIN = 420;
const PANE_CHROME = 8 + 1;

export interface HelpScreenProps {
  /** On a phone, the shelf and the open plate occupy one surface each. */
  stacked?: boolean;
}

export function HelpScreen({ stacked = false }: HelpScreenProps) {
  const set = HELP_SET;
  const view = useNavStore((state) => state.view);
  const openSlug = view.view === 'help' ? view.plate : null;
  const contentsPref = usePanelWidth('help.contents', CONTENTS_DEFAULT, CONTENTS_MIN);

  const selectedIndex = useMemo(
    () => set.pages.findIndex((page) => page.slug === openSlug),
    [set.pages, openSlug],
  );
  const selected = selectedIndex >= 0 ? set.pages[selectedIndex] ?? null : null;
  const selectedChapter = selected
    ? set.chapters.find((chapter) => chapter.id === selected.sectionId) ?? null
    : null;

  /** Opening a plate is USER navigation: a push, so Back returns to the last one. */
  const open = useCallback((slug: string | null) => {
    navStore.getState().navigate({ view: 'help', plate: slug });
  }, []);

  /*
   * THE DESKTOP LANDING, and the one `replace` this screen writes.
   *
   * Two panes are up and the right one has nothing else to hold, so a bare
   * `/help` opens plate 01. Written into the ROUTE rather than kept as a local
   * default, because a URL reading `/help` while plate 01 is on screen is a URL
   * that shares the wrong thing — and `replace` rather than `push` because the
   * reader did not navigate here, so Back must still leave Help instead of
   * bouncing between two spellings of the same screen.
   *
   * A slug naming no plate lands here too and is corrected the same way: a
   * retired or mistyped link opens the guide at its first page.
   */
  useEffect(() => {
    if (stacked || view.view !== 'help' || selected) return;
    const first = set.pages[0];
    if (!first) return;
    navStore.setState((state) => ({
      view: { view: 'help', plate: first.slug },
      history: 'replace',
      revision: state.revision + 1,
    }));
  }, [stacked, view.view, selected, set.pages]);

  const selectRelative = useCallback(
    (delta: number) => {
      if (selectedIndex < 0) return;
      const next = set.pages[selectedIndex + delta];
      if (next) open(next.slug);
    },
    [selectedIndex, set.pages, open],
  );

  const contents = (
    <HelpContents set={set} selectedSlug={openSlug} onSelect={open} stacked={stacked} />
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
              onBack={() => open(null)}
              onPrevious={selectedIndex > 0 ? () => selectRelative(-1) : undefined}
              onNext={selectedIndex < set.pages.length - 1 ? () => selectRelative(1) : undefined}
            />
            <HelpReader page={selected} />
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
            <HelpReader page={selected} />
          </>
        ) : (
          <p className="hlp-empty" role="status">Choose a plate from the contents.</p>
        )}
      </section>
    </div>
  );
}

function HelpContents({ set, selectedSlug, onSelect, stacked }: {
  set: HelpSet;
  selectedSlug: string | null;
  onSelect(slug: string): void;
  stacked: boolean;
}) {
  const openChapters = set.chapters.filter((chapter) => chapter.pages.length > 0).length;
  return (
    <div className="hlp-contents__body">
      <header className="hlp-masthead">
        <div className="hlp-masthead__kicker"><span>tm8</span><span aria-hidden>◆</span><span>Field guide</span></div>
        <h1 className="hlp-masthead__title">Help</h1>
        <p className="hlp-masthead__lede">A practical library for understanding the graph, finding your footing, and working well together.</p>
        <p className="hlp-masthead__measure" aria-label={`${set.pages.length} plates across ${openChapters} populated chapters`}>
          {set.pages.length} {set.pages.length === 1 ? 'plate' : 'plates'} <span aria-hidden>·</span> {openChapters} {openChapters === 1 ? 'chapter' : 'chapters'} open
        </p>
      </header>

      <ChapterMap chapters={set.chapters} />
      <div className="hlp-library" data-testid="help-library">
        {set.chapters.filter((chapter) => chapter.pages.length > 0).map((chapter) => (
          <HelpChapterSection
            key={chapter.id}
            chapter={chapter}
            selectedSlug={selectedSlug}
            onSelect={onSelect}
            stacked={stacked}
          />
        ))}
      </div>
    </div>
  );
}

function ChapterMap({ chapters }: { chapters: readonly HelpChapter[] }) {
  return (
    <section className="hlp-map" aria-labelledby="hlp-map-title">
      <div className="hlp-rule"><span id="hlp-map-title">Reading map</span></div>
      <ol className="hlp-map__list">
        {chapters.map((chapter) => (
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

function HelpChapterSection({ chapter, selectedSlug, onSelect, stacked }: {
  chapter: HelpChapter;
  selectedSlug: string | null;
  onSelect(slug: string): void;
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
          const active = !stacked && page.slug === selectedSlug;
          return (
            <li key={page.slug}>
              <button
                type="button"
                className={`hlp-row ${active ? 'hlp-row--active' : ''}`}
                data-testid="help-row"
                data-help-page
                aria-current={active ? 'page' : undefined}
                onClick={() => onSelect(page.slug)}
                onKeyDown={moveHelpFocus}
              >
                <span className="hlp-row__n" aria-hidden>{String(page.number).padStart(2, '0')}</span>
                <VectorIcon paths={KIND_ART.artifact} className="hlp-row__mark" />
                <span className="hlp-row__text">
                  <span className="hlp-row__title">{page.title}</span>
                  <span className="hlp-row__excerpt">{page.excerpt}</span>
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
        <p className="hlp-reader__progress">Plate {page.number} of {pageCount}</p>
      </div>
      <div className="hlp-reader__steps" aria-label="Page navigation">
        <button type="button" className="hlp-step" disabled={!onPrevious} onClick={onPrevious} aria-label="Previous Help page"><span aria-hidden>←</span></button>
        <button type="button" className="hlp-step" disabled={!onNext} onClick={onNext} aria-label="Next Help page"><span aria-hidden>→</span></button>
      </div>
      <div className="hlp-progress-track" aria-hidden><span style={{ width: `${(page.number / pageCount) * 100}%` }} /></div>
    </header>
  );
}

function HelpReader({ page }: { page: HelpPage }) {
  return (
    <div className="hlp-reader__body" data-testid="help-page">
      <HelpPlate plate={page.plate} />
    </div>
  );
}
