// @vitest-environment jsdom
/**
 * THE HELP SHELF — the static guide, the reader, and the address of a plate.
 *
 * WHAT THESE CASES EXIST TO PIN, in the order they matter:
 *
 *  · THE GUIDE SHIPS WITH THE APP. This suite once tested a seam that answered
 *    a collection and its edges, because the failure being recovered from was
 *    five Help artifacts orphaned in a graph nothing could name. The owner then
 *    ruled the other way, for the reason that outranks it: a reader whose graph
 *    is unreachable is exactly the reader who needs the manual. So the screen
 *    is rendered with NO seam and NO space, and is expected to be complete.
 *
 *  · THE PLATE IS SANDBOXED, EXACTLY. `allow-scripts` and nothing else — an
 *    added `allow-same-origin` would hand 55 documents of third-party-shaped
 *    HTML this app's cookies, storage and DOM. The assertion is on the exact
 *    string, so a widened sandbox cannot pass as "still sandboxed".
 *
 *  · THE GUIDE OPENS ON ITS OWN FRONT PAGE. A bare `/help` shows the home —
 *    what tm8 IS, then the map of the whole guide — never a plate nobody
 *    chose: plate 01 teaches HOW tm8 works, which is the wrong first page for
 *    a reader who has not been told what it is.
 *
 *  · A PLATE IS AN ADDRESS. It lives in the route, so it can be linked,
 *    reloaded and Back-ed. An unknown slug degrades to the home — where the
 *    map is — rather than to a broken screen.
 *
 *  · THE PHONE IS ONE COLUMN AND HAS A WAY BACK. `stacked` opens on the home
 *    and contents in one scroll (never inside a page nobody chose) and a page
 *    opened over them carries a back verb — the only exit on a phone.
 *
 * jsdom loads no stylesheets (the recurring law of this suite), so nothing here
 * claims colour, width or geometry — presence, order and text only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import type { SpaceId } from '@tm8/contract';
import { GateApp } from '../views/GateApp';
import { navStore, resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';
import { build, createMemoryTarget, parse } from '../routes';
import { FIXTURE_SPACE_ID } from '../fixtures';
import { HELP_CHAPTERS, HELP_SET, searchHelpSet } from './help-set';
import { HELP_PLATES } from './help-plates';
import { PLATE_MAX_HEIGHT, PLATE_MESSAGE_SOURCE, PLATE_MIN_HEIGHT, heightFromMessage, withPlateReporter } from './plate-frame';
import { HelpScreen } from './HelpScreen';

const SPACE = FIXTURE_SPACE_ID as SpaceId;
const FIRST = HELP_PLATES[0]!;
const SECOND = HELP_PLATES[1]!;

/** Land on Help the way the router does, so the screen reads a real route. */
function onHelp(plate: string | null = null) {
  resetNav(SPACE, { view: 'help', plate });
}

/*
 * THE PLATE BYTES ARE STUBBED HERE, and that is the right seam. `HelpPlate`
 * fetches the vendored bundle and hands it to the frame; jsdom serves no assets
 * and renders no frame document, so a real fetch would only prove that jsdom
 * cannot fetch. What THIS file tests is the shell around the plate — which one
 * is addressed, how the frame is sandboxed, what the colophon says. The bytes
 * themselves are pinned by `help-plates.test.ts`, against the real files, in a
 * node environment that can read them.
 */
const STUB_PLATE = '<!doctype html><html><body><h1>stub plate</h1></body></html>';

beforeEach(() => {
  onHelp();
  screenStackStore.getState().clearAll();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(STUB_PLATE, {
    status: 200,
    headers: { 'content-type': 'text/html' },
  })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the help set', () => {
  it('is the whole library, in plate order, with no fetch', () => {
    expect(HELP_SET.pages).toHaveLength(HELP_PLATES.length);
    expect(HELP_SET.pages.map((page) => page.number)).toEqual(
      HELP_PLATES.map((plate) => plate.number).sort((a, b) => a - b),
    );
  });

  it('groups plates into the content tree, keeping every chapter declared', () => {
    /* Every chapter is present in `chapters` even when empty — the screen
       decides what to draw, and a resolver that dropped empties would make an
       empty chapter indistinguishable from one that does not exist. */
    expect(HELP_SET.chapters.map((chapter) => chapter.id)).toEqual(
      HELP_CHAPTERS.map((chapter) => chapter.id),
    );
    const grouped = HELP_SET.chapters.flatMap((chapter) => chapter.pages);
    expect(grouped).toHaveLength(HELP_SET.pages.length);
    for (const chapter of HELP_SET.chapters) {
      for (const page of chapter.pages) expect(page.sectionId).toBe(chapter.id);
    }
  });

  it('carries the plate’s own lede as its shelf line', () => {
    /* The contents needs a sentence under each title and the truth floor
       forbids inventing one: every excerpt is the artifact's own `<p class=
       "lede">`, lifted at vendor time. */
    for (const page of HELP_SET.pages) {
      expect(page.excerpt, page.slug).toBe(page.plate.lede);
      expect(page.excerpt.length, page.slug).toBeGreaterThan(20);
    }
  });

  it('finds familiar feature language while preserving matching chapters', () => {
    const tasks = searchHelpSet(HELP_SET, 'tasks');
    const workPages = HELP_SET.chapters.find((chapter) => chapter.id === '4')!.pages;
    expect(tasks.chapters.map((chapter) => chapter.id)).toContain('4');
    expect(tasks.pages).toEqual(expect.arrayContaining(workPages));
    expect(tasks.pages.length).toBeLessThan(HELP_SET.pages.length);

    const invite = searchHelpSet(HELP_SET, 'bearer code');
    expect(invite.pages.map((page) => page.slug)).toEqual(['the-invite']);

    expect(searchHelpSet(HELP_SET, 'AGENTS').chapters.map((chapter) => chapter.id)).toContain('3');
    expect(searchHelpSet(HELP_SET, 'qqq no-such-feature').pages).toEqual([]);
  });
});

describe('the help screen', () => {
  it('lists the whole guide and opens on the home, never inside a plate', () => {
    const view = render(<HelpScreen />);
    expect(view.getAllByTestId('help-row')).toHaveLength(HELP_PLATES.length);
    expect(view.getAllByTestId('help-chapter').map((chapter) => chapter.getAttribute('data-section')))
      .toEqual(HELP_CHAPTERS.map((chapter) => chapter.id));

    /* The reader pane holds the FRONT PAGE — what tm8 is, then the map — and
       the URL still reads a bare `/help`: nothing was opened on the reader's
       behalf, so there is nothing to correct or to Back out of. */
    expect(view.getByTestId('help-home')).toBeTruthy();
    expect(view.getByRole('heading', { level: 1, name: 'What is tm8?' })).toBeTruthy();
    expect(view.queryByTestId('help-plate')).toBeNull();
    expect(navStore.getState().view).toEqual({ view: 'help', plate: null });
    view.unmount();
  });

  it('maps the whole guide on the home, and a chapter card opens its first plate', async () => {
    const view = render(<HelpScreen />);
    /* Every declared chapter is on the map, in content-tree order — the home
       is the master page, so an absent chapter here is an unreachable one. */
    const cards = view.getAllByTestId('help-home-chapter');
    expect(cards.map((card) => card.getAttribute('data-section')))
      .toEqual(HELP_CHAPTERS.map((chapter) => chapter.id));

    const second = HELP_SET.chapters.find((chapter) => chapter.pages.length > 0 && chapter.id !== FIRST.section)!;
    fireEvent.click(cards[HELP_SET.chapters.indexOf(second)]!);
    const entry = second.pages[0]!;
    expect(navStore.getState().view).toEqual({ view: 'help', plate: entry.slug });
    expect(navStore.getState().history).toBe('push');
    await waitFor(() => expect(view.getByTestId('help-plate').getAttribute('data-plate')).toBe(entry.slug));
    view.unmount();
  });

  it('begins the guide at plate one from the hero, as a push', async () => {
    const view = render(<HelpScreen />);
    fireEvent.click(view.getByTestId('help-home-begin'));
    /* Opening a plate IS navigation: a push, so Back is the home. */
    expect(navStore.getState().view).toEqual({ view: 'help', plate: FIRST.slug });
    expect(navStore.getState().history).toBe('push');
    await waitFor(() => expect(view.getByTestId('help-plate').getAttribute('data-plate')).toBe(FIRST.slug));
    expect(view.getByText(`Plate 1 of ${HELP_PLATES.length}`)).toBeTruthy();
    view.unmount();
  });

  it('offers outcome-led starting points, and opens the selected proof plate', async () => {
    const view = render(<HelpScreen />);
    const starts = view.getAllByTestId('help-starting-point');
    expect(starts).toHaveLength(4);
    expect(starts.map((start) => start.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining('See one request become real work'),
      expect.stringContaining('Meet teammates and sessions'),
    ]));

    fireEvent.click(starts[2]!);
    expect(navStore.getState().view).toEqual({ view: 'help', plate: 'anatomy-of-a-teammate' });
    await waitFor(() => expect(view.getByTestId('help-plate').getAttribute('data-plate')).toBe('anatomy-of-a-teammate'));
    view.unmount();
  });

  it('searches the shelf by product language, clears, and explains no results', () => {
    const view = render(<HelpScreen />);
    const input = view.getByTestId('help-search') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'agents' } });
    const agents = searchHelpSet(HELP_SET, 'agents');
    expect(view.getAllByTestId('help-row')).toHaveLength(agents.pages.length);
    expect(view.getByTestId('help-search-status').textContent).toBe(`${agents.pages.length} plates found`);
    expect(view.getAllByTestId('help-chapter').map((chapter) => chapter.getAttribute('data-section')))
      .toContain('3');
    expect(view.getAllByTestId('help-row').length).toBeLessThan(HELP_PLATES.length);

    fireEvent.change(input, { target: { value: 'nothing-in-tm8-matches-this' } });
    expect(view.queryAllByTestId('help-row')).toHaveLength(0);
    expect(view.getByTestId('help-search-empty').textContent).toContain('No guide pages match');

    fireEvent.click(view.getByRole('button', { name: 'Show the full guide' }));
    expect(input.value).toBe('');
    expect(view.getAllByTestId('help-row')).toHaveLength(HELP_PLATES.length);
    view.unmount();
  });

  it('writes the opened plate into the route, and reads it back', async () => {
    const view = render(<HelpScreen />);
    fireEvent.click(view.getAllByTestId('help-row')[1]!);
    /* Opening a plate IS navigation: a push, so Back is "previous plate". */
    expect(navStore.getState().view).toEqual({ view: 'help', plate: SECOND.slug });
    expect(navStore.getState().history).toBe('push');
    await waitFor(() => expect(view.getByTestId('help-plate').getAttribute('data-plate')).toBe(SECOND.slug));
    view.unmount();
  });

  it('opens the plate a deep link addresses', async () => {
    const target = HELP_PLATES[30]!;
    onHelp(target.slug);
    const view = render(<HelpScreen />);
    await waitFor(() => expect(view.getByTestId('help-plate').getAttribute('data-plate')).toBe(target.slug));
    expect(view.getByText(`Plate ${target.number} of ${HELP_PLATES.length}`)).toBeTruthy();
    view.unmount();
  });

  it('degrades a retired or mistyped slug to the home instead of breaking', async () => {
    onHelp('a-plate-that-was-renumbered');
    const view = render(<HelpScreen />);
    /* The correction is a REPLACE — the reader did not navigate to the home,
       so Back must leave Help rather than revisit the dead address. */
    await waitFor(() => expect(navStore.getState().view).toEqual({ view: 'help', plate: null }));
    expect(navStore.getState().history).toBe('replace');
    expect(view.getByTestId('help-home')).toBeTruthy();
    view.unmount();
  });

  it('renders the plate in a frame sandboxed to scripts and nothing else', async () => {
    onHelp(FIRST.slug);
    const view = render(<HelpScreen />);
    const frame = await waitFor(() => {
      const found = view.container.querySelector('iframe');
      if (!found) throw new Error('no frame yet');
      return found;
    });
    /* EXACT equality, never `toContain`: `allow-scripts allow-same-origin`
       contains `allow-scripts` and is the one combination that undoes the
       sandbox entirely. */
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.getAttribute('title')).toContain(FIRST.title);
    view.unmount();
  });

  it('hands the frame the published bytes with the reporter appended, never an edit', () => {
    /* The plate's own markup is untouched and the shim goes AFTER it, which is
       what keeps `help-plates.test.ts`'s SHA-256 pin meaningful: the file on
       disk is still the published revision, byte for byte. */
    const published = '<!doctype html><html><body>plate</body></html>';
    const doc = withPlateReporter(published);
    expect(doc.startsWith(published)).toBe(true);
    expect(doc.slice(published.length)).toContain(PLATE_MESSAGE_SOURCE);
  });

  it('shows where the plate came from, by artifact and revision', async () => {
    onHelp(FIRST.slug);
    const view = render(<HelpScreen />);
    const colophon = await waitFor(() => view.getByTestId('help-plate-provenance'));
    expect(colophon.textContent).toContain(FIRST.provenance.artifactId);
    expect(colophon.textContent).toContain(String(FIRST.provenance.revision));
    view.unmount();
  });

  it('accepts a height only from the plate\u2019s own window, and clamps it', () => {
    /* EVERY sandboxed frame reports origin `"null"`, so origin cannot tell one
       plate from another \u2014 or from any other opaque frame on the page. The
       sending WINDOW is the only usable identity, which is why this is the
       check and not `event.origin`. */
    const frame = { contentWindow: {} } as unknown as HTMLIFrameElement;
    const message = (data: unknown, source: unknown) =>
      ({ data, source } as unknown as MessageEvent);

    expect(heightFromMessage(message({ source: PLATE_MESSAGE_SOURCE, height: 900 }, frame.contentWindow), frame)).toBe(900);
    /* An impostor window is refused even with a perfectly-shaped payload. */
    expect(heightFromMessage(message({ source: PLATE_MESSAGE_SOURCE, height: 900 }, {}), frame)).toBeNull();
    expect(heightFromMessage(message({ source: 'something-else', height: 900 }, frame.contentWindow), frame)).toBeNull();
    expect(heightFromMessage(message('not-an-object', frame.contentWindow), frame)).toBeNull();
    expect(heightFromMessage(message({ source: PLATE_MESSAGE_SOURCE, height: 'tall' }, frame.contentWindow), frame)).toBeNull();
    /* A buggy or hostile plate cannot ask for a two-million-pixel element. */
    expect(heightFromMessage(message({ source: PLATE_MESSAGE_SOURCE, height: 9e9 }, frame.contentWindow), frame)).toBe(PLATE_MAX_HEIGHT);
    expect(heightFromMessage(message({ source: PLATE_MESSAGE_SOURCE, height: 1 }, frame.contentWindow), frame)).toBe(PLATE_MIN_HEIGHT);
  });

  it('steps forward and back through the reading order', async () => {
    onHelp(FIRST.slug);
    const view = render(<HelpScreen />);
    await waitFor(() => view.getByTestId('help-plate'));
    /* Plate one has no previous: the first step control is refused rather than
       silently wrapping to the end of the guide. */
    const [previous, next] = view.getAllByRole('button', { name: /Help page$/ }) as HTMLButtonElement[];
    expect(previous!.disabled).toBe(true);

    fireEvent.click(next!);
    await waitFor(() => expect(view.getByTestId('help-plate').getAttribute('data-plate')).toBe(SECOND.slug));
    view.unmount();
  });

  it('returns from a desktop plate to the guide home', async () => {
    onHelp(FIRST.slug);
    const view = render(<HelpScreen />);
    await waitFor(() => view.getByTestId('help-plate'));

    fireEvent.click(view.getByRole('button', { name: 'Back to Help home' }));
    expect(navStore.getState().view).toEqual({ view: 'help', plate: null });
    await waitFor(() => view.getByTestId('help-home'));
    view.unmount();
  });

  it('supports arrow, Home and End navigation through the reading order', () => {
    const view = render(<HelpScreen />);
    const rows = view.getAllByTestId('help-row');
    rows[0]!.focus();
    fireEvent.keyDown(rows[0]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1]!, { key: 'End' });
    expect(document.activeElement).toBe(rows.at(-1));
    fireEvent.keyDown(rows.at(-1)!, { key: 'Home' });
    expect(document.activeElement).toBe(rows[0]);
    view.unmount();
  });

  it('has no critical or serious automated accessibility findings', async () => {
    const view = render(
      <main>
        <HelpScreen />
      </main>,
    );
    /* The landing IS the home — the master page is what a new reader meets
       first, so it is what this floor is held against, alongside the shelf. */
    await waitFor(() => view.getByTestId('help-home'));
    /* `iframes: false` — axe cannot reach into a plate from here and should
       not try: jsdom never loads the frame's document, and each plate was
       independently axe-checked at publish time against the same floor. What
       is under test is the SHELL around it. */
    const results = await axe.run(view.container, {
      iframes: false,
      rules: { 'color-contrast': { enabled: false } },
    });
    const blocking = results.violations.filter((violation) =>
      violation.impact === 'critical' || violation.impact === 'serious');
    expect(blocking, blocking.map((violation) => `${violation.id}: ${violation.help}`).join('\n')).toEqual([]);
    view.unmount();
    /* 20s, not the 5s default: axe walks the WHOLE guide — 55 rows, ten
       chapters and the reader — and this file runs alongside 320 others. The
       old three-row fixture fit in the default; a real library does not. */
  }, 20_000);

  it('opens on the home and contents on a phone, and a page carries a way back', async () => {
    const view = render(<HelpScreen stacked />);
    /* One surface, read top to bottom: the front page first — what tm8 is,
       then the map — with the whole shelf on the same scroll below it. */
    expect(view.getByTestId('help-home')).toBeTruthy();
    expect(view.getAllByTestId('help-row')).toHaveLength(HELP_PLATES.length);
    /* NOT auto-opened: a stacked shell that selected plate one would land a
       reader inside a page they never chose, with the shelf they came for one
       back-press away. */
    expect(view.queryByTestId('help-back')).toBeNull();
    expect(navStore.getState().view).toEqual({ view: 'help', plate: null });

    fireEvent.click(view.getAllByTestId('help-row')[0]!);
    const back = await waitFor(() => view.getByTestId('help-back'));
    expect(view.queryAllByTestId('help-row')).toHaveLength(0);

    fireEvent.click(back);
    await waitFor(() => expect(view.getAllByTestId('help-row')).toHaveLength(HELP_PLATES.length));
    view.unmount();
  });

  it('a chapter card on the phone scrolls to that chapter’s shelf, not into a page', () => {
    /* jsdom implements no scrolling; the assertion is that the card's verb IS
       a scroll on the one surface — the route must still read a bare `/help`,
       because showing the reader where a chapter sits is not navigation. */
    const scrolls = vi.fn();
    const hadScroll = 'scrollIntoView' in window.HTMLElement.prototype;
    (window.HTMLElement.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrolls;
    try {
      const view = render(<HelpScreen stacked />);
      fireEvent.click(view.getAllByTestId('help-home-chapter')[0]!);
      expect(scrolls).toHaveBeenCalled();
      expect(navStore.getState().view).toEqual({ view: 'help', plate: null });
      view.unmount();
    } finally {
      if (!hadScroll) delete (window.HTMLElement.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });
});

describe('prompts inside help (the chip retired 2026-08-29)', () => {
  /*
   * 'prompts' is a RESERVED slug, not a plate: the codec passes the segment
   * through verbatim, the screen claims it before the dead-slug correction
   * runs, and the reader pane hosts the live catalog. The plate registry
   * stays pinned at 55 — these cases assert the guest mount, not a 56th page.
   */
  it('help/prompts renders the prompt catalog inside the reader pane', () => {
    onHelp('prompts');
    const view = render(<HelpScreen />);

    /* The catalog is IN the reader pane — the same surface a plate uses — not
       an overlay over the guide. */
    const reader = view.getByTestId('help-reader');
    expect(reader.querySelector('[data-testid="prompts-screen"]')).toBeTruthy();
    /* Not presented as a plate: no sandboxed frame, no "Plate N of 55". */
    expect(view.queryByTestId('help-plate')).toBeNull();
    /* Mounted WITHOUT `onClose`: the ✕ belonged to the retired overlay, and
       the way out of the catalog is Help's own chrome. */
    expect(view.queryByLabelText('Close prompts')).toBeNull();

    /* The shelf's annex entry is the door, and it reads as current — while
       the phone shelf deliberately has no entry (the pr-* grid has no stacked
       mode), so this entry is the desktop contents' own. */
    expect(view.getByTestId('help-prompts-entry').getAttribute('aria-current')).toBe('page');

    /* The address survives as written — linkable, reloadable, Back-able. */
    expect(navStore.getState().view).toEqual({ view: 'help', plate: 'prompts' });
    view.unmount();
  });

  it('the dead-slug redirect still degrades unknown slugs but never eats prompts', async () => {
    /* The reserved slug matches no plate BY DESIGN, which is exactly the shape
       the correction effect fires on — so the exemption is the whole feature:
       mount, let effects run, and the URL must still say prompts. */
    onHelp('prompts');
    const view = render(<HelpScreen />);
    await Promise.resolve();
    expect(navStore.getState().view).toEqual({ view: 'help', plate: 'prompts' });
    expect(view.getByTestId('help-reader').querySelector('[data-testid="prompts-screen"]')).toBeTruthy();
    view.unmount();

    /* And the correction itself is not weakened: a genuinely dead slug still
       degrades to the front page, as a replace. */
    onHelp('prompts-but-misspelled-or-retired');
    const degraded = render(<HelpScreen />);
    await waitFor(() => expect(navStore.getState().view).toEqual({ view: 'help', plate: null }));
    expect(navStore.getState().history).toBe('replace');
    expect(degraded.getByTestId('help-home')).toBeTruthy();
    degraded.unmount();
  });
});

describe('the help route', () => {
  it('mounts the shelf at #/s/{s}/help', async () => {
    /* The tab-mount wiring end to end: contract ref → route codec →
       `landingOfRoute` → GateApp's branch. */
    const view = render(<GateApp routerTarget={createMemoryTarget(`#/s/${SPACE}/help`)} />);
    await waitFor(() => view.getByTestId('help-screen'));
    view.unmount();
  });

  it('round-trips a plate as a trailing segment', () => {
    const parsed = parse(`#/s/${SPACE}/help/${SECOND.slug}`).route;
    expect(parsed?.target).toEqual({ view: 'help', plate: SECOND.slug });
    expect(build(parsed!).hash).toBe(`#/s/${SPACE}/help/${SECOND.slug}`);

    const bare = parse(`#/s/${SPACE}/help`).route;
    expect(bare?.target).toEqual({ view: 'help', plate: null });
    expect(build(bare!).hash).toBe(`#/s/${SPACE}/help`);
  });

  it('is the final tab, owns current state, and has no duplicate ? control', async () => {
    const view = render(<GateApp routerTarget={createMemoryTarget(`#/s/${SPACE}/home`)} />);
    await waitFor(() => view.getByTestId('space-tab-bar'));
    const tablist = view.getByRole('tablist', { name: 'Screens' });
    const tabs = [...tablist.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      // 'Chats' joined the spine 2026-09-03 (migration 180) and left again
      // 2026-09-05 (migration 184) — its door is Home's icon rail now. Help is
      // still the FINAL tab, which is what this case is actually about.
      'Home', 'Work', 'Board', 'Craft', 'Graph', 'CodeBrain', 'Settings', 'Help',
    ]);
    expect(view.queryByTestId('open-help')).toBeNull();

    fireEvent.click(view.getByRole('tab', { name: 'Help' }));
    await waitFor(() => view.getByTestId('help-screen'));
    expect(view.getByRole('tab', { name: 'Help' }).getAttribute('aria-selected')).toBe('true');
    view.unmount();
  });
});
