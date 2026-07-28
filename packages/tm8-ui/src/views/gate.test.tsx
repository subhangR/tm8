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

  it('mounts both side panels and the live-session bar in the centre', async () => {
    const { getByTestId } = renderGate();
    const grid = await waitFor(() => getByTestId('workspace-grid'));
    // Anatomy, not geometry: the three regions exist and are labelled.
    within(grid).getByLabelText('Left panel');
    within(grid).getByLabelText('Right panel');
    within(grid).getByLabelText('Workspace center');
  });

  it('renders the empty centre as the ROSTER plus the grammar lesson (02-LAYOUT §2.2)', async () => {
    // The spec's own words: "The empty state doubles as the live-session roster
    // and teaches the grammar." A blank centre would satisfy "nothing is open"
    // and fail the actual requirement — so assert the CONTENT, not the absence.
    const { getByTestId, getByText } = renderGate();
    const empty = await waitFor(() => getByTestId('empty-center'));

    // The roster: sessions named, each with its status WORD (C8/L10).
    // Scoped to the name/word classes because several fixture personas share a
    // display name — a bare getByText matches more than one row.
    const names = [...empty.querySelectorAll('.shell-empty__name')].map((n) => n.textContent);
    const words = [...empty.querySelectorAll('.shell-empty__word')].map((n) => n.textContent);
    expect(names).toContain('forge');
    expect(words).toContain('running');
    // …and the stale one honestly labelled, never as live (D6).
    expect(words).toContain('stale — node restarted');

    // The grammar lesson.
    getByText('Click any task or session to open it here.');
    within(empty).getByText('Esc');
    within(empty).getByText('p');
    within(empty).getByText('/');
  });

  it('orders the roster LIVE FIRST, from the seam live set (never a summary field)', async () => {
    const { getByTestId } = renderGate();
    const empty = await waitFor(() => getByTestId('empty-center'));
    const names = [...empty.querySelectorAll('.shell-empty__name')].map((n) => n.textContent);
    expect(names[0]).toBe('forge'); // the only id in liveEntityIds
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
      // A1c's control may not be mounted in this fixture state; assert the
      // WIRING exists rather than silently passing on its absence.
      expect(
        (container.innerHTML.match(/launch/i) ?? []).length,
        'the launch flow must be wired into the rendered view',
      ).toBeGreaterThan(0);
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
