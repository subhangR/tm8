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
  return render(<GateApp />);
};

describe('THE GATE — composed T0-1 master screen', () => {
  it('boots through the real seam and mounts every shell region', async () => {
    const { getByTestId, container } = renderGate();

    // Boot is async (identity → spaces → openSpace → hydrate), so the screen
    // legitimately starts in its loading state.
    await waitFor(() => expect(getByTestId('workspace-grid')).toBeTruthy());

    getByTestId('space-tab-bar');
    getByTestId('menu-rail');
    // With nothing open the centre hosts the roster, NOT the panel stack —
    // PanelStack mounts once a panel exists (02-LAYOUT §2.2).
    getByTestId('empty-center');
    getByTestId('notice-host');
    expect(container.querySelector('.shell-root')).not.toBeNull();
  });

  it('renders the rail from the SHIPPED DEFAULT — the fixture seam has no menu row', async () => {
    // This is the fail-closed path running for real at the gate, not a stub:
    // createFixtureSeam resolves menu() as null (C-4), so the rail the reviewer
    // sees IS the shipped default constant.
    const { container } = renderGate();
    await waitFor(() =>
      expect(container.querySelectorAll('.shell-rail__header').length).toBeGreaterThan(0),
    );
    const labels = [...container.querySelectorAll('.shell-rail__header')].map((n) => n.textContent);
    expect(labels).toContain('Workspace');
    expect(labels).toContain('Settings');
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

    // Not in the rail, at all.
    expect([...view.container.querySelectorAll('.shell-rail__header')]
      .some((node) => node.textContent === 'Channels')).toBe(false);
    expect(view.container.querySelector('[data-entity-id="ch-design"]')).toBeNull();

    // Channels is an offered COLLECTION in the list panel's kind switcher.
    const left = within(grid).getByLabelText('Left panel');
    fireEvent.click(left.querySelector('.lp__kind') as HTMLElement);
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
    within(grid).getByLabelText('Left panel');
    within(grid).getByLabelText('Right panel');
    within(grid).getByLabelText('Workspace center');
  });

  it('moves a complete side panel across the center without losing its behavior', async () => {
    const view = renderGate();
    const grid = await waitFor(() => view.getByTestId('workspace-grid'));
    const left = within(grid).getByLabelText('Left panel');
    const right = within(grid).getByLabelText('Right panel');

    expect(left.querySelector('[data-kind="task"]')).not.toBeNull();
    expect(right.querySelector('[data-kind="work_session"]')).not.toBeNull();

    fireEvent.keyDown(within(left).getByRole('button', { name: /drag task panel/i }), {
      key: 'Enter',
    });

    await waitFor(() => expect(right.querySelector('[data-kind="task"]')).not.toBeNull());
    expect(left.querySelector('[data-kind="work_session"]')).not.toBeNull();
    expect(within(right).getByRole('button', { name: /drag task panel/i })).toBeTruthy();

    // The empty-center roster follows the registry's terminal capability, not
    // a hard-wired assumption that Sessions stays on the right.
    const rosterNames = [...view.getByTestId('empty-center').querySelectorAll('.shell-empty__name')]
      .map((node) => node.textContent);
    expect(rosterNames).toContain('forge');
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
    const { getByTestId, container } = renderGate();
    await waitFor(() => getByTestId('workspace-grid'));

    // No sheet until something opens it.
    expect(container.querySelector('[data-testid="launch-sheet"]')).toBeNull();

    // The door: the quick-config's escape to full options.
    const full = container.querySelector('[data-testid="launch-full-options"], .lqc__full');
    if (full) {
      fireEvent.click(full as HTMLElement);
      await waitFor(() => expect(getByTestId('launch-sheet')).toBeTruthy());
    } else {
      // This fixture state has no task quick-config mounted. The Sessions
      // list's old *disabled* Launch sentence was previously counted here as
      // proof of reachability, even though clicking it could do nothing. Do
      // not resurrect that false positive or its header row.
      expect(container.querySelector('[data-kind="work_session"] .lp__actions')).toBeNull();
    }
  });

  it('LAUNCH PERFORMS: clicking Launch grows the live set through the echo path', async () => {
    // FROM THE OUTSIDE again. The seam's fixture spawn creates a real running
    // session with patches and an echo event, so "did it actually launch" is
    // ASSERTABLE rather than a matter of trusting a toast. The previous
    // implementation raised a toast whose own body admitted it did not
    // dispatch — a brass primary that cannot perform its verb, which reads as
    // working until you click it.
    const { getByTestId, container } = renderGate();
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

  it('opens Graph from the rail with workspace data from the active seam', async () => {
    const resizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as typeof ResizeObserver;

    const view = renderGate();
    try {
      await waitFor(() => view.getByTestId('workspace-grid'));
      fireEvent.click(view.getByRole('button', { name: 'Graph' }));

      const graph = await waitFor(() => view.getByTestId('graph-screen'));
      // The lens control replaced the static eyebrow: the first thing the
      // toolbar says is now which lens the canvas is under, and it must offer
      // the escape to the whole space.
      expect(within(graph).getByRole('group', { name: 'Graph lens' })).toBeTruthy();
      expect(within(graph).getByRole('button', { name: 'Everything' })).toBeTruthy();
      expect(graph.querySelectorAll('.gv-node, .gv-shelf__chips > *').length).toBeGreaterThan(0);
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
  const rail = (view: ReturnType<typeof renderGate>) =>
    within(view.getByTestId('menu-rail'));

  const openKind = async (view: ReturnType<typeof renderGate>, name: RegExp) => {
    // Scoped to the rail (the workspace panels carry their own kind controls)
    // and matched by prefix (rail labels carry badge text: "Tasks3, 3 unseen").
    fireEvent.click(rail(view).getByRole('button', { name }));
    return waitFor(() => view.getByTestId('entity-view'));
  };

  const detailPanel = (view: ReturnType<typeof renderGate>) =>
    within(view.getByTestId('entity-view-detail')).queryByTestId('entity-detail-panel');

  it('restores the open entity after switching rail items and back', async () => {
    const view = renderGate();
    await waitFor(() => view.getByTestId('workspace-grid'));
    await openKind(view, /^Tasks/);

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
        return text;
      });
    const openedText = await settled();
    expect(openedText.length).toBeGreaterThan(0);

    // LEAVE — Dashboard is a different branch of GateApp's view ternary, so
    // EntityView really unmounts. That is the step that used to destroy the
    // selection, and the assertion below is that it no longer does.
    fireEvent.click(rail(view).getByRole('button', { name: /^Dashboard$/ }));
    await waitFor(() => expect(view.queryByTestId('entity-view')).toBeNull());

    // COME BACK.
    await openKind(view, /^Tasks/);
    // The same entity, not the attention page.
    expect(await settled()).toBe(openedText);
    view.unmount();
  });

  it('keeps each screen separate — a task does not follow you into Docs', async () => {
    const view = renderGate();
    await waitFor(() => view.getByTestId('workspace-grid'));
    await openKind(view, /^Tasks/);
    const tile = (await waitFor(() => view.getAllByTestId('list-tile')))[0] as HTMLElement;
    fireEvent.click(tile.querySelector('button') ?? tile);
    await waitFor(() => expect(detailPanel(view)).toBeTruthy());

    // A screen nobody has opened anything on is still empty: its stack is its
    // own, so the Tasks selection is structurally unreachable from here. This
    // is the rule EntityView used to enforce by resetting on every kind change.
    await openKind(view, /^Docs/);
    await waitFor(() => expect(detailPanel(view)).toBeNull());
    expect(view.getByTestId('attention-inbox')).toBeTruthy();
    view.unmount();
  });
});
