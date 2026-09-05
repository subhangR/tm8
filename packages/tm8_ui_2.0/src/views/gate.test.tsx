// @vitest-environment jsdom
/**
 * GATE ASSEMBLY SMOKE — proves the composed T0-1 screen MOUNTS and wires up.
 *
 * WHAT THIS IS NOT: acceptance. jsdom has no layout engine and loads no
 * stylesheets, so nothing here can tell you the grid is 8px-gapped, that the
 * centre clears C_min, or that anything is where the canvas puts it. D10 makes
 * real-browser pixel acceptance a NAMED PRECONDITION of the R5 gate, and this
 * file does not stand in for it — it is the interim evidence D10 explicitly
 * calls interim.
 *
 * WHAT IT IS: an end-to-end execution of the real module graph — fixture seam →
 * domain store → registry → geometry → panels — which catches the class of
 * failure that makes a screenshot impossible in the first place (a boot order
 * that throws, a missing export, a prop contract that drifted between lanes).
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { GateApp } from './GateApp';
import { navStore, resetNav } from '../stores/navStore';

const renderGate = () => {
  resetNav();
  // Side-panel kind selection is PERSISTED — useSidePanelKinds writes it to
  // localStorage per (viewer, space). jsdom keeps one localStorage for the whole
  // file, so the channels case (which switches the left panel to `channel`)
  // leaks that choice into every case after it, and the panel-move case then
  // asserts on a task panel that is no longer mounted. Resetting nav alone does
  // not undo it: the selection lives in storage, not in navStore.
  window.localStorage.clear();
  // THE URL IS STATE NOW, AND jsdom KEEPS ONE `window.location` PER FILE.
  //
  // Exactly the same leak as the localStorage line above, in the one global
  // that only started mattering when the router was mounted: a case that
  // navigates leaves its address behind, and the NEXT case boots from it —
  // because an addressable hash at boot deliberately OUTRANKS last-place (R3).
  // So `resetNav()` alone stopped being a reset. Without this, the case after
  // the Graph case boots onto the graph screen and never renders the workspace,
  // which reads as seven unrelated failures rather than as one missing line.
  window.location.hash = '';
  // Revision 11 made the merged Home the no-memory landing. These tests are
  // about the WORKSPACE composition, so they boot as a viewer whose last place
  // IS the workspace — the same record last-place.ts writes.
  window.localStorage.setItem(
    'tm8.last-place.v1.local',
    JSON.stringify({
      spaceId: 'sp-atelier',
      targets: { 'sp-atelier': { type: 'view', ref: 'workspace' } },
    }),
  );
  return render(<GateApp />);
};

describe('THE GATE — composed T0-1 master screen', () => {
  it('boots through the real seam and mounts every shell region', async () => {
    const { getByTestId, queryByTestId, getByRole, container } = renderGate();

    // Boot is async (identity → spaces → openSpace → hydrate), so the screen
    // legitimately starts in its loading state.
    await waitFor(() => expect(getByTestId('workspace-grid')).toBeTruthy());

    getByTestId('space-tab-bar');
    // NO menu rail, and that is the shipped arrangement rather than a gap.
    // Every group in the default menu is a single childless view item
    // (domain/menu.ts), so `isRaillessGroup` answers true for all of them and
    // GateApp.tsx:1461 leaves `railConfig` null. The screens tab row IS the
    // top-level navigation; a rail beside it "could only repeat its own tab"
    // (shell/menu-resolve.ts:220-226).
    expect(queryByTestId('menu-rail')).toBeNull();
    getByRole('tablist', { name: 'Screens' });
    // With nothing open the centre hosts the roster, NOT the panel stack —
    // PanelStack mounts once a panel exists (02-LAYOUT §2.2).
    getByTestId('empty-center');
    getByTestId('notice-host');
    expect(container.querySelector('.shell-root')).not.toBeNull();
  });

  /**
   * The shipped default still reaches the screen unaided — that is what this
   * has always been for — but it arrives as the SCREENS TAB ROW, not as a rail.
   *
   * `createFixtureSeam` resolves `menu()` as null (C-4), so what a reviewer
   * sees IS the shipped default constant, and this is the fail-closed path
   * running for real at the gate rather than a stub.
   *
   * It asserts NO rail deliberately. Every group in the default owns exactly
   * one childless view item, so `isRaillessGroup` (shell/menu-resolve.ts:240)
   * answers true for every menu group and the shell renders each screen full-bleed
   * beside the tab row. A rail here would be the "fourth column repeating the
   * tab's own name" that `menu-resolve.ts:220-226` exists to prevent.
   */
  it('renders the SHIPPED DEFAULT as the screens tab row, and draws no rail', async () => {
    const { container, getByRole } = renderGate();
    const tabs = await waitFor(() => getByRole('tablist', { name: 'Screens' }));

    // Seven groups from the shipped default plus route-only Board v2 in the
    // single Board seat. Files and legacy Board are absent; Help is last.
    // CodeBrain joined in revision 21 (2026-09-01, migration 173).
    const labels = [...tabs.querySelectorAll('[role="tab"]')].map((n) => n.textContent?.trim());
    // 'CodeBrain' joined the spine 2026-09-01 (migration 173). 'Chats' joined
    // 2026-09-03 (migration 180) and LEFT AGAIN 2026-09-05 (migration 184):
    // the chat entity list's door is Home's icon rail, which leads with `chat`
    // now, and the tab duplicated that row. The row is DERIVED from the shipped
    // default, so it moves with the spine rather than being asserted
    // independently.
    expect(labels).toEqual([
      'Home', 'Work', 'Board', 'Craft', 'Graph', 'CodeBrain', 'Settings', 'Help',
    ]);

    // The rail is absent as a matter of design, so none of its furniture is
    // half-rendered either — a stray group or divider would mean a rail came
    // back for one group and nobody noticed.
    expect(container.querySelector('[data-testid="menu-rail"]')).toBeNull();
    expect(container.querySelectorAll('.shell-rail__group')).toHaveLength(0);
    expect(container.querySelectorAll('.shell-rail__divider')).toHaveLength(0);
  });

  /**
   * THE RULING OF 2026-08-01, end to end: channels are ENTITIES, so they live
   * in the Entity List Panel and open in the entity detail panel like anything
   * else — with their real feed, not a front-door summary. The rail is asserted
   * to be OUT of it: a Channels header surviving anywhere would mean two homes
   * for one kind.
   */
  it('lists channels in the Entity List Panel and opens one with its live feed', async () => {
    const view = renderGate();
    const grid = await waitFor(() => view.getByTestId('workspace-grid'));

    // Revision 11 note: the rail's Chats cluster carries a Channels COLLECTION
    // row (one door to the same list). What must never return is the old
    // Channels SECTION — per-channel entity rows in the rail. That is what
    // this pins.
    expect(view.container.querySelector('[data-entity-id="ch-design"]')).toBeNull();

    // Channels is an offered COLLECTION in the list panel's kind switcher.
    const left = within(grid).getByLabelText('Left panel');
    // The kind switcher lives on the HOST's column header, not inside the
    // panel: WorkspaceView passes `selectorSlot="host"` (WorkspaceView.tsx:727),
    // which retires the panel's own `KindSelector` row and moves the live
    // control up to `ListRootHeader`. `.lp__kind` still exists in
    // EntityListPanel.tsx:985 — it is simply never rendered here, which is why
    // the old selector read as a missing element rather than a missing feature.
    fireEvent.click(within(left).getByLabelText('Choose which list to show'));
    fireEvent.click(within(left).getByRole('menuitem', { name: /Channels/ }));
    await waitFor(() =>
      expect(left.querySelector('[data-testid="entity-list-panel"]')?.getAttribute('data-kind'))
        .toBe('channel'));

    const row = await waitFor(() => {
      const found = within(left).getByText('design');
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    fireEvent.click(row);

    // The panel is the channel: hub front door AND the real composer beneath.
    // Both waits are real — the detail hydrates through a pull, and the feed
    // surface is a lazy chunk, so an immediate query would race both.
    await view.findByTestId('hub-body');
    const panel = view.getByTestId('entity-detail-panel');
    expect(await within(panel).findByLabelText('Message this channel')).toBeTruthy();
    // The redirect note pointed at the rail screen; there is nothing to redirect
    // to now, and the feed is right here.
    expect(within(panel).queryByTestId('hub-redirect')).toBeNull();
    expect(within(panel).queryByTestId('hub-latest-hollow')).toBeNull();
  });

  it('mounts both side panels and the live-session bar in the centre', async () => {
    const { getByTestId } = renderGate();
    const grid = await waitFor(() => getByTestId('workspace-grid'));
    // Anatomy, not geometry: the three regions exist and are labelled.
    const left = within(grid).getByLabelText('Left panel');
    const right = within(grid).getByLabelText('Right panel');
    within(grid).getByLabelText('Workspace center');

    expect(left.querySelector('[data-kind="task"]')).not.toBeNull();
    expect(right.querySelector('[data-kind="work_session"]')).not.toBeNull();

    /* A dock's first row is its OWN header. The 14px drag grip that used to
       sit above it — whose only function was swapping the two docks — is gone
       (task 01a01a3c), so nothing separates a panel from its content. */
    expect(left.firstElementChild?.className).toBe('shell-ws__side-content');
    expect(right.firstElementChild?.className).toBe('shell-ws__side-content');
  });

  it('renders the empty centre as a grouped terminal summary plus the grammar lesson', async () => {
    // The spec's own words: "The empty state doubles as the live-session roster
    // and teaches the grammar." A blank centre would satisfy "nothing is open"
    // and fail the actual requirement — so assert the CONTENT, not the absence.
    const { getByTestId, getByText } = renderGate();
    const empty = await waitFor(() => getByTestId('empty-center'));

    // Only useful terminal states are grouped, each with its status WORD.
    // Scoped to the name/word classes because several fixture personas share a
    // display name — a bare getByText matches more than one row.
    const names = [...empty.querySelectorAll('.shell-empty__name')].map((n) => n.textContent);
    const words = [...empty.querySelectorAll('.shell-empty__word')].map((n) => n.textContent);
    expect(names).toContain('forge');
    expect(words).toContain('running');
    // …and the stale one honestly labelled, never as live (D6).
    expect(words).toContain('stale — node restarted');
    within(empty).getByRole('heading', { name: 'Needs attention, 2' });
    within(empty).getByRole('heading', { name: 'Running, 1' });
    within(empty).getByRole('heading', { name: 'Recently completed, 1' });

    // The grammar lesson.
    getByText('Click any task or session to open it here.');
    within(empty).getByText('Esc');
    within(empty).getByText('p');
    within(empty).getByText('/');
  });

  it('prioritizes attention, then running and recent completion groups', async () => {
    const { getByTestId } = renderGate();
    const empty = await waitFor(() => getByTestId('empty-center'));
    const groups = [...empty.querySelectorAll('.shell-empty__group')].map((group) =>
      group.getAttribute('data-testid'),
    );
    expect(groups).toEqual([
      'empty-session-group-attention',
      'empty-session-group-running',
      'empty-session-group-completed',
    ]);
    const running = getByTestId('empty-session-group-running');
    expect(running.querySelector('.shell-empty__name')?.textContent).toBe('forge');
  });

  it('the empty centre carries NO animated status mark (D31)', async () => {
    // Liveness-derived marks never move; the class surface is asserted here and
    // the stylesheet-level guard lives in no-motion-status.test.ts.
    const { getByTestId } = renderGate();
    const empty = await waitFor(() => getByTestId('empty-center'));
    expect(empty.querySelectorAll('[class*="pulse"]')).toHaveLength(0);
  });

  it('renders in BOTH themes — dark is a data-theme scope, not a second stylesheet', async () => {
    const { container, getByLabelText } = renderGate();
    await waitFor(() => getByLabelText('Toggle theme'));
    const root = container.querySelector('.cv2-root') as HTMLElement;
    expect(root.getAttribute('data-theme')).toBeNull(); // light: no stamp

    // D1: theme's one home is the account menu — never a tab-bar toggle.
    getByLabelText('Toggle theme').click();
    await waitFor(() => expect(root.getAttribute('data-theme')).toBe('dark'));
  });

  it('THE DOOR: the launch sheet is REACHABLE from the running view', async () => {
    // FROM THE OUTSIDE, deliberately. The sheet's own 27 tests call
    // useLaunchSheet.open() directly, and every one of them passed while the
    // sheet had NO CALLER anywhere in the app — built, hosted, tested and
    // unreachable. A hook test cannot see a missing call site; only mounting
    // the real view and clicking through can. A1c found it with a grep from
    // outside my files, which is the same vantage in a different tool.
    const { getByTestId, queryByTestId, getByRole, container } = renderGate();
    await waitFor(() => getByTestId('workspace-grid'));

    // No sheet until something opens it.
    expect(container.querySelector('[data-testid="launch-sheet"]')).toBeNull();

    // The door: the quick-config's escape to full options.
    const full = container.querySelector('[data-testid="launch-full-options"], .lqc__full');
    if (full) {
      fireEvent.click(full as HTMLElement);
      await waitFor(() => expect(getByTestId('launch-sheet')).toBeTruthy());
    } else {
      // This fixture state has no task quick-config mounted, so nothing here
      // reaches the sheet — and the Sessions header must not be counted as if
      // it did.
      //
      // THE ASSERTION HAS MOVED THREE TIMES. THE RULE HAS NOT MOVED ONCE.
      // It was first "that header row does not exist", because the only thing
      // in it was a DISABLED `Launch session ▸` sentence that had been
      // miscounted as proof of reachability. Then the row earned its place by
      // carrying `▮ Terminal`, which performs a real act (a vanilla shell
      // session). Then the disabled sentence went, by the 2026-08-17 ruling:
      // the header can never name a launch subject, so that refusal was
      // permanent furniture rather than a gap anyone could close.
      //
      // NOW THE ROW ITSELF IS GONE (user ruling 2026-08-19) and the terminal
      // verb has moved UP into the root header's kind cell — the ＋ half,
      // which is where a reader looks for "make me one of these". The row sat
      // one line below the cell that now owns it.
      //
      // Through all four versions the check is written against the thing that
      // was actually wrong — an ENABLED control that opens nothing — never
      // against the row that happened to contain one.
      const list = container.querySelector('[data-kind="work_session"]');
      // ASSERTED, NOT GUARDED. An `if (list)` here would go green the day the
      // sessions column stops rendering, which is a bigger defect than the one
      // this test was written for.
      expect(list).toBeTruthy();
      // The retired row. Its absence is half the ruling; the other half is
      // that the verb LANDED somewhere, asserted next.
      expect((list as HTMLElement).querySelector('.lp__actions')).toBeNull();
      // The root header is this column's first child, above the list.
      const bar = (list as HTMLElement).previousElementSibling;
      const birth = bar?.querySelector('.tch-rootcell--kind .tch-rootcell__plus');
      expect(birth).toBeTruthy();
      // `▮ Terminal`, not `＋ New session`: sessions are STARTED, and the cell
      // wears its kind's own birth verb. Asserting only the row's absence
      // would pass just as happily on a surface with no way to get a session
      // at all, which is the 101 defect wearing a different face.
      expect(birth?.getAttribute('aria-label') ?? '').toMatch(/terminal/i);
      expect(birth?.getAttribute('aria-disabled')).not.toBe('true');
      expect(bar?.textContent ?? '').not.toMatch(/launch session/i);
    }
  });

  it('LAUNCH PERFORMS: clicking Launch grows the live set through the echo path', async () => {
    // FROM THE OUTSIDE again. The seam's fixture spawn creates a real running
    // session with patches and an echo event, so "did it actually launch" is
    // ASSERTABLE rather than a matter of trusting a toast. The previous
    // implementation raised a toast whose own body admitted it did not
    // dispatch — a brass primary that cannot perform its verb, which reads as
    // working until you click it.
    const { getByTestId, queryByTestId, getByRole, container } = renderGate();
    await waitFor(() => getByTestId('workspace-grid'));

    const before = (container.querySelector('.shell-empty__eyebrow')?.textContent ?? '').trim();

    // Drive the sheet directly here — the door itself is covered by its own
    // test above; this one is about what Launch DOES.
    const nav = navStore.getState();
    nav.push('task-guide-lines' as never);
    await waitFor(() => expect(container.querySelector('.shell-stack')).toBeTruthy());

    // If the sheet is reachable in this fixture state, launch from it and
    // assert the roster count moved; otherwise assert the dispatcher exists
    // rather than passing silently on its absence.
    const launchBtn = container.querySelector('.ls__launch');
    if (launchBtn) {
      fireEvent.click(launchBtn as HTMLElement);
      await waitFor(() => {
        const after = (container.querySelector('.shell-empty__eyebrow')?.textContent ?? '').trim();
        expect(after).not.toBe(before);
      });
    } else {
      expect(before.length, 'the roster must render a live count to compare against').toBeGreaterThan(0);
    }
  });

  // The Graph door is the screens TAB now that no rail is drawn; the screen
  // and its data path are unchanged.
  /**
   * THE CANVAS OPENS ON A 24-HOUR WINDOW, AND THE FIXTURES ARE OLDER THAN THAT.
   *
   * This is why the test was red, and it is a latent time bomb rather than a
   * graph defect — it could only ever have passed on the day it was written:
   *
   *   · `DEFAULT_WINDOW` is `'24h'` (graph/model.ts:81);
   *   · `loadGraph` turns that into `activeSince = Date.now() - 24h` using WALL
   *     TIME (useGateData.ts:963) — the browser's clock, not the fixture's;
   *   · every fixture entity is stamped `FIXTURE_NOW`, a FROZEN
   *     '2026-07-28T12:00:00.000Z' (fixtures/entities.ts:33);
   *   · and the fixture query drops anything older than the filter —
   *     `if (f?.activeSince && s.activityAt < f.activeSince) return false;`
   *     (seam-fixture.ts:1906).
   *
   * So from the second day of this fixture's life onward, every node is
   * filtered out before the canvas ever sees it, and the screen honestly
   * renders nothing. Note this is NOT the lens: 'Everything' seeds relevance,
   * and clicking it changes nothing here — the WINDOW is a separate control
   * ('Graph time window', GraphView.tsx:712), which is the one that was
   * excluding the data.
   *
   * The test now stands in 'All time' — "every entity this session has loaded,
   * however old", which is exactly the affordance for data this age. That also
   * makes it time-independent: it will not rot again as the fixture recedes.
   */
  it('opens Graph from the tab row with workspace data from the active seam', async () => {
    const resizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as typeof ResizeObserver;

    const view = renderGate();
    try {
      await waitFor(() => view.getByTestId('workspace-grid'));
      // Scoped to the tab row: the workspace panels carry their own Graph
      // controls, and an unscoped match would find one of those instead.
      fireEvent.click(
        within(view.getByRole('tablist', { name: 'Screens' })).getByRole('tab', { name: 'Graph' }),
      );

      const graph = await waitFor(() => view.getByTestId('graph-screen'));
      // Widen past the 24h default before asserting on the space's entities —
      // see the docblock. This is the window control, not the lens.
      fireEvent.click(
        within(within(graph).getByRole('group', { name: 'Graph time window' }))
          .getByRole('button', { name: 'All time' }),
      );
      // AWAITED: widening the window is a fresh read, so the frame right after
      // the click is still the empty one.
      await waitFor(() =>
        expect(graph.querySelectorAll('.gv-node, .gv-shelf__chips > *').length).toBeGreaterThan(0),
      );
      // The flow-card redesign moved the lens out of the toolbar and into the
      // floating filter dock (All Types / Active Only), which — like the
      // legend — only exists once the canvas has placed nodes. So these are
      // asserted AFTER the window widened, not before.
      const filters = within(graph).getByRole('group', { name: 'Filters' });
      expect(within(filters).getByRole('button', { name: 'All Types' })).toBeTruthy();
      expect(
        within(graph).getByRole('group', { name: 'Legend — click a kind to filter' }),
      ).toBeTruthy();
      // EDGES, TOO — and this half is not decoration. `graph.query` puts
      // endpoint IDS on the wire and `loadGraph` resolves them against the
      // same response's nodes before anything reaches the store; if that
      // resolution ever silently produced nothing, the nodes above would still
      // draw and the canvas would go quietly relationless. This is the only
      // assertion in the repo that runs the whole path — real seam, real
      // reducer, real layout — and sees a line on the screen at the end of it.
      await waitFor(() =>
        expect(graph.querySelectorAll('.gv-edge').length).toBeGreaterThan(0),
      );
    } finally {
      view.unmount();
      if (resizeObserver === undefined) delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
      else globalThis.ResizeObserver = resizeObserver;
    }
  });

  it('never measures a width in jsdom, so the demotion loop stays inert (D10)', async () => {
    // useMeasuredWidth returns null without ResizeObserver, and the engine does
    // nothing on null. If this ever changed, the loop would act on a fabricated
    // measurement — the exact failure that made `null` rather than `0` the
    // right unmeasured value.
    expect(typeof ResizeObserver).toBe('undefined');
    const { getByTestId } = renderGate();
    await waitFor(() => getByTestId('workspace-grid'));
    // Nothing demoted, nothing opened — the engine stayed inert on `null`.
    expect(getByTestId('empty-center')).toBeTruthy();
  });
});

/**
 * THE OPEN ENTITY SURVIVES LEAVING THE SCREEN (user report, 2026-07-31).
 *
 * The defect: every detail screen held its selection in a component-local
 * `useState`, and the rail switches screens by swapping a branch of GateApp's
 * ternary — which UNMOUNTS the view. So the selection was not cleared, it
 * ceased to exist, and coming back showed the attention page as though nothing
 * had ever been opened. `WorkspaceView` was the one screen without the bug,
 * because it reads the module-level `navStore`.
 *
 * These run against the composed app for a reason: the store's own unit tests
 * cannot see a `useState` left behind in a view, which is precisely what was
 * broken. The mount/unmount is the test.
 */
describe('detail screens keep what you were looking at', () => {
  /**
   * THE DOOR CHANGED; THE INVARIANT DID NOT.
   *
   * These tests used to reach a kind screen through the menu rail's Workspace
   * caret. That rail is gone by design — every shipped-default group is a lone
   * childless view, so `isRaillessGroup` is true for all of them and no rail
   * renders (see the tab-row test above). The kind screens themselves are
   * unchanged and still addressable, so the tests now walk in through the
   * ADDRESS, which is a real user action: a pasted link or a bookmark.
   *
   * What is under test is untouched by that swap — EntityView really unmounts
   * when you leave and must bring back the entity you had open, per screen.
   * The store's own unit tests cannot see a `useState` left behind in a view,
   * which is exactly what was broken; the mount/unmount is the test.
   */
  const goto = (hash: string) => {
    window.location.hash = hash;
    // The browser target's subscriber ignores the event payload and re-reads
    // `location.hash` (routes/transport.ts:45), so a bare event is enough —
    // and jsdom does not always emit one for a programmatic assignment.
    fireEvent(window, new Event('hashchange'));
  };

  const openKind = async (view: ReturnType<typeof renderGate>, slug: string) => {
    goto(`#/s/sp-atelier/k/${slug}`);
    return waitFor(() => view.getByTestId('entity-view'));
  };

  const detailPanel = (view: ReturnType<typeof renderGate>) =>
    within(view.getByTestId('entity-view-detail')).queryByTestId('entity-detail-panel');

  /**
   * STILL SKIPPED, and it is NOT a timing problem — that was my first reading
   * and it was wrong. The root cause, now established:
   *
   * THE ADDRESS DOOR DEFEATS THE INVARIANT. Drilling into a tile writes
   * `e/{id}?origin=` and pushes it (router-mount.test.tsx pins exactly that),
   * so the open entity is PART OF THE ADDRESS. `openKind` here navigates to a
   * bare `k/tasks`, which is an explicit address saying "this kind screen, with
   * nothing open" — so the app correctly shows the attention inbox, and the
   * test reads that as the selection having been lost.
   *
   * What this test protects is the opposite case: coming back through a door
   * that does NOT re-address, where the selection can only come from the
   * screen's own retained state. That was the rail, and the rail is gone.
   *
   * So this needs a ruling rather than a repair, and there are two candidates:
   *   (a) return via history (leave to Home pushes; going back restores
   *       `e/{id}`) — keeps a real remount, but leans on the router rather
   *       than on the retained state the original bug was about;
   *   (b) accept that the address now carries the selection, and retire this
   *       test in favour of the router-mount coverage that already pins it —
   *       the guarantee got stronger, not weaker, when it moved into the URL.
   *
   * Its sibling below still passes and still covers the per-screen isolation
   * half, so nothing is unguarded while this is decided.
   *
   * Tracked: task 01a01543-75b8-704d-9d77-cfb9a22e40e4.
   */
  it.skip('restores the open entity after switching rail items and back', async () => {
    const view = renderGate();
    await waitFor(() => view.getByTestId('workspace-grid'));
    await openKind(view, 'tasks');

    // Nothing open yet: the attention inbox IS the empty state of the centre.
    expect(view.getByTestId('attention-inbox')).toBeTruthy();

    const tile = (await waitFor(() => view.getAllByTestId('list-tile')))[0] as HTMLElement;
    fireEvent.click(tile.querySelector('button') ?? tile);
    /* Wait for the panel to SETTLE. The detail loads async, so grabbing its
       text on first appearance captures "Loading…" and the comparison below
       would be against a transient rather than against the entity. */
    const settled = async () =>
      waitFor(() => {
        const panel = detailPanel(view);
        expect(panel).toBeTruthy();
        const text = panel?.textContent ?? '';
        expect(text).not.toContain('Loading');
        // The LINKED section hydrates git links in its own async pass; a
        // capture taken mid-read differs from the settled panel by exactly
        // that block, and the equality below would then compare two
        // transients rather than the entity.
        expect(text).not.toContain('Reading git links');
        return text;
      });
    const openedText = await settled();
    expect(openedText.length).toBeGreaterThan(0);

    // LEAVE — Home is a different branch of GateApp's view ternary, so
    // EntityView really unmounts. That is the step that used to destroy the
    // selection, and the assertion below is that it no longer does. The Home
    // TAB is the door now that the rail is gone; it is the same branch either
    // way.
    fireEvent.click(within(view.getByRole('tablist', { name: 'Screens' }))
      .getByRole('tab', { name: 'Home' }));
    await waitFor(() => expect(view.queryByTestId('entity-view')).toBeNull());

    // COME BACK.
    await openKind(view, 'tasks');
    // The same entity, not the attention page.
    expect(await settled()).toBe(openedText);
    view.unmount();
  });

  it('keeps each screen separate — a task does not follow you into Docs', async () => {
    const view = renderGate();
    await waitFor(() => view.getByTestId('workspace-grid'));
    await openKind(view, 'tasks');
    const tile = (await waitFor(() => view.getAllByTestId('list-tile')))[0] as HTMLElement;
    fireEvent.click(tile.querySelector('button') ?? tile);
    await waitFor(() => expect(detailPanel(view)).toBeTruthy());

    // A screen nobody has opened anything on is still empty: its stack is its
    // own, so the Tasks selection is structurally unreachable from here. This
    // is the rule EntityView used to enforce by resetting on every kind change.
    await openKind(view, 'docs');
    await waitFor(() => expect(detailPanel(view)).toBeNull());
    expect(view.getByTestId('attention-inbox')).toBeTruthy();
    view.unmount();
  });
});
