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
 * THE GUIDE OPENS ON ITS OWN FRONT PAGE. A bare `/help` shows `HelpHome` — what
 * tm8 IS, then the map of the whole guide — rather than auto-opening plate 01,
 * which taught HOW tm8 works to a reader who had not yet been told what it is.
 * The home is the `plate: null` spelling of the route, so it is linkable and
 * Back returns to it after any plate.
 *
 * WHICH PLATE IS OPEN IS THE URL'S. `navStore` holds it as `view.plate`, so a
 * plate is linkable, reloadable and Back-able: every open is a history push,
 * which makes the browser's Back button the reader's "previous page" and makes
 * a Help link something you can send someone. The one route this screen writes
 * with `replace` is the correction of a dead slug — see the effect below.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';

import { PanelResizer, VectorIcon, usePanelWidth } from '../kit';
import { KIND_ART, SURFACE_ART } from '../domain';
import { navStore, useNavStore } from '../stores/navStore';
import { PromptsScreen } from '../prompts';
import { HelpHome } from './HelpHome';
import { HelpPlate } from './HelpPlate';
import { HELP_SET, searchHelpSet, type HelpChapter, type HelpPage, type HelpSet } from './help-set';
import './help.css';

const CONTENTS_DEFAULT = 376;
const CONTENTS_MIN = 280;
const READER_MIN = 420;
const PANE_CHROME = 8 + 1;

/**
 * 'prompts' IS A RESERVED SLUG, NOT A PLATE (2026-08-29, the chip's
 * retirement). The route codec passes any trailing segment through verbatim,
 * so `/help/prompts` arrives here as `view.plate === 'prompts'` with no codec
 * change — this screen claims it BEFORE the dead-slug correction can degrade
 * it, and hosts the prompt catalog in the reader pane. It stays outside
 * `HELP_SET` deliberately: the plate registry is pinned at 55 vendored
 * artifacts and the catalog is a live surface, not a published page.
 */
const PROMPTS_SLUG = 'prompts';

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
  /** The reserved non-plate address — the prompt catalog in the reader pane. */
  const promptsOpen = openSlug === PROMPTS_SLUG;

  /** Opening a plate is USER navigation: a push, so Back returns to the last one. */
  const open = useCallback((slug: string | null) => {
    navStore.getState().navigate({ view: 'help', plate: slug });
  }, []);

  /*
   * A DEAD SLUG DEGRADES TO THE FRONT PAGE, and this is the one `replace` this
   * screen writes. A retired or mistyped link opens the guide at its home —
   * where the map is — rather than a broken reader, and the URL is corrected to
   * say so, because `/help/a-plate-that-is-gone` while the home is on screen is
   * a URL that shares the wrong thing. `replace` rather than `push` because the
   * reader did not navigate here: Back must still leave Help instead of
   * bouncing between two spellings of the same screen.
   *
   * `PROMPTS_SLUG` is exempt: it matches no plate BY DESIGN — it is the
   * catalog's address, not a dead link — so the correction must never eat it.
   */
  useEffect(() => {
    if (view.view !== 'help' || view.plate === null || view.plate === PROMPTS_SLUG || selected) return;
    navStore.setState((state) => ({
      view: { view: 'help', plate: null },
      history: 'replace',
      revision: state.revision + 1,
    }));
  }, [view, selected]);

  const selectRelative = useCallback(
    (delta: number) => {
      if (selectedIndex < 0) return;
      const next = set.pages[selectedIndex + delta];
      if (next) open(next.slug);
    },
    [selectedIndex, set.pages, open],
  );

  /** A chapter card in the reader-pane home opens that chapter's first plate. */
  const openChapter = useCallback(
    (chapter: HelpChapter) => {
      const first = chapter.pages[0];
      if (first) open(first.slug);
    },
    [open],
  );

  const contents = (
    <HelpContents set={set} selectedSlug={openSlug} onSelect={open} stacked={stacked} />
  );

  if (stacked) {
    /* `/help/prompts` ON A PHONE lands on the shelf below: `selected` is null
       for the reserved slug, the correction effect leaves the address alone,
       and the stacked shelf offers no prompts entry (see `HelpContents`) — the
       catalog's three-pane `pr-*` grid has no stacked mode, so the gate is
       deliberate, not an accident of the branch. */
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
        className={`hlp-reader ${promptsOpen ? 'hlp-reader--prompts' : ''}`}
        aria-labelledby={selected || promptsOpen ? 'hlp-reader-title' : 'hlp-home-title'}
        data-testid="help-reader"
      >
        {promptsOpen ? (
          <PromptsReader onBack={() => open(null)} />
        ) : selected && selectedChapter ? (
          <>
            <ReaderHeader
              page={selected}
              chapter={selectedChapter}
              pageCount={set.pages.length}
              onBack={() => open(null)}
              onPrevious={selectedIndex > 0 ? () => selectRelative(-1) : undefined}
              onNext={selectedIndex < set.pages.length - 1 ? () => selectRelative(1) : undefined}
            />
            <HelpReader page={selected} />
          </>
        ) : (
          <HelpHome set={set} onOpen={open} onChapter={openChapter} />
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
  const [query, setQuery] = useState('');
  const searchId = useId();
  const filtered = useMemo(() => searchHelpSet(set, query), [set, query]);
  const searching = query.trim().length > 0;
  return (
    <div className="hlp-contents__body">
      {stacked ? (
        /* The phone has ONE surface, so the front page and the shelf share it:
           the home reads first — what tm8 is, then the map — and a chapter card
           scrolls to that chapter's shelf section below, where the plates are. */
        <HelpHome set={set} onOpen={onSelect} onChapter={scrollToChapterShelf} />
      ) : (
        <>
          <header className="hlp-masthead">
            <div className="hlp-masthead__kicker"><span>tm8</span><span aria-hidden>◆</span><span>Field guide</span></div>
            <h1 className="hlp-masthead__title">Help</h1>
            <p className="hlp-masthead__lede">A practical library for understanding the graph, finding your footing, and working well together.</p>
            <p className="hlp-masthead__measure" aria-label={`${set.pages.length} plates across ${openChapters} populated chapters`}>
              {set.pages.length} {set.pages.length === 1 ? 'plate' : 'plates'} <span aria-hidden>·</span> {openChapters} {openChapters === 1 ? 'chapter' : 'chapters'} open
            </p>
          </header>

          <ChapterMap chapters={set.chapters} />
        </>
      )}
      <section className="hlp-search" aria-labelledby={`${searchId}-label`}>
        <div className="hlp-search__heading">
          <label id={`${searchId}-label`} htmlFor={searchId}>Find a topic</label>
          <span aria-live="polite" data-testid="help-search-status">
            {searching
              ? `${filtered.pages.length} ${filtered.pages.length === 1 ? 'plate' : 'plates'} found`
              : 'Search all titles, chapters and feature names'}
          </span>
        </div>
        <div className="hlp-search__control">
          <input
            id={searchId}
            type="search"
            value={query}
            data-testid="help-search"
            placeholder="Try tasks, agents, memory, channels…"
            autoComplete="off"
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          {searching ? (
            <button type="button" onClick={() => setQuery('')} aria-label="Clear Help search">Clear</button>
          ) : null}
        </div>
      </section>
      {filtered.pages.length > 0 ? (
        <div className="hlp-library" data-testid="help-library">
          {filtered.chapters.map((chapter) => (
            <HelpChapterSection
              key={chapter.id}
              chapter={chapter}
              selectedSlug={selectedSlug}
              onSelect={onSelect}
              stacked={stacked}
            />
          ))}
        </div>
      ) : (
        <div className="hlp-search-empty" data-testid="help-search-empty">
          <p>No guide pages match “{query.trim()}”.</p>
          <span>Try a feature name such as tasks, graph, sessions, memory, Craft, or channels.</span>
          <button type="button" onClick={() => setQuery('')}>Show the full guide</button>
        </div>
      )}
      {stacked ? null : (
        /* NO PROMPTS ENTRY ON THE PHONE SHELF — the catalog's three-pane
           `pr-*` grid has no stacked mode, and a door to a surface that cannot
           lay out on this screen would be a control that performs badly by
           design. The gate is deliberate, not an accident: the entry returns
           when the catalog grows a one-column shape. */
        <PromptsShelfEntry
          active={selectedSlug === PROMPTS_SLUG}
          onOpen={() => onSelect(PROMPTS_SLUG)}
        />
      )}
    </div>
  );
}

/**
 * THE ANNEX — the one shelf entry that is NOT a plate. It sits in its own
 * small section under the ten chapters because it is a different kind of
 * thing: a live catalog read from the composers, not a vendored page, so it
 * carries no plate number, no `data-help-page` (the arrow-key ring traverses
 * the READING ORDER, which this is outside of) and no `help-row` testid (the
 * suite counts those against the 55-plate registry).
 */
function PromptsShelfEntry({ active, onOpen }: { active: boolean; onOpen(): void }) {
  return (
    <section className="hlp-annex" aria-labelledby="hlp-annex-title" data-testid="help-annex">
      <div className="hlp-rule"><span id="hlp-annex-title">Beyond the guide</span></div>
      <button
        type="button"
        className={`hlp-row ${active ? 'hlp-row--active' : ''}`}
        data-testid="help-prompts-entry"
        aria-current={active ? 'page' : undefined}
        onClick={onOpen}
      >
        <span className="hlp-row__n" aria-hidden>◆</span>
        <VectorIcon paths={SURFACE_ART.terminal} className="hlp-row__mark" />
        <span className="hlp-row__text">
          <span className="hlp-row__title">Prompts</span>
          <span className="hlp-row__excerpt">
            Every system prompt tm8 sends an agent, and every operation the CLI can
            describe — read live from the composers themselves.
          </span>
        </span>
        <span className="hlp-row__arrow" aria-hidden>→</span>
      </button>
    </section>
  );
}

/**
 * The catalog, hosted in the reader pane. A ReaderHeader-equivalent head keeps
 * the pane's grammar — crumb, one titled heading the section is labelled by —
 * but no plate number, no progress and no steps: the catalog is outside the
 * reading order and inventing a "Plate 56" would be a lie. `PromptsScreen` is
 * mounted WITHOUT `onClose` (its ✕ belonged to the retired overlay); the way
 * out is Help's own chrome, exactly like every plate.
 */
function PromptsReader({ onBack }: { onBack(): void }) {
  return (
    <>
      <header className="hlp-reader__head">
        <button type="button" className="hlp-back hlp-back--home" onClick={onBack} aria-label="Back to Help home">
          <span aria-hidden>‹</span><span>Guide home</span>
        </button>
        <div className="hlp-reader__identity">
          <p className="hlp-reader__crumb"><span>Annex</span><span aria-hidden>◆</span><span>Beyond the guide</span></p>
          <h1 id="hlp-reader-title" className="hlp-reader__title">System prompts</h1>
        </div>
      </header>
      <div className="hlp-prompts-host" data-testid="help-prompts-host">
        <PromptsScreen />
      </div>
    </>
  );
}

/** The stacked home's chapter verb: the shelf is on the same surface, below. */
function scrollToChapterShelf(chapter: HelpChapter) {
  document.getElementById(`hlp-shelf-${chapter.id}`)?.scrollIntoView({ block: 'start' });
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
    <section id={`hlp-shelf-${chapter.id}`} className="hlp-chapter" aria-labelledby={headingId} data-testid="help-chapter" data-section={chapter.id}>
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
      <button
        type="button"
        className={`hlp-back ${stacked ? '' : 'hlp-back--home'}`}
        data-testid="help-back"
        onClick={onBack}
        aria-label={stacked ? 'Back to Help contents' : 'Back to Help home'}
      >
        <span aria-hidden>‹</span><span>{stacked ? 'Contents' : 'Guide home'}</span>
      </button>
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
