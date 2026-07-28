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
import { render, waitFor, within } from '@testing-library/react';
import { GateApp } from './GateApp';
import { resetNav } from '../stores/navStore';

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
    getByTestId('panel-stack');
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

  it('starts with an empty centre that still holds its slot (02-LAYOUT §2.2)', async () => {
    const { getByTestId } = renderGate();
    await waitFor(() => getByTestId('workspace-grid'));
    // V=0 — the stack renders its empty state rather than collapsing, which is
    // what keeps C_min at one panel column with nothing open.
    expect(getByTestId('panel-stack').getAttribute('data-slots')).toBe('0');
  });

  it('renders in BOTH themes — dark is a data-theme scope, not a second stylesheet', async () => {
    const { container, getByLabelText } = renderGate();
    await waitFor(() => getByLabelText('Account menu'));
    const root = container.querySelector('.cv2-root') as HTMLElement;
    expect(root.getAttribute('data-theme')).toBeNull(); // light: no stamp

    // D1: theme's one home is the account menu — never a tab-bar toggle.
    getByLabelText('Account menu').click();
    await waitFor(() => expect(root.getAttribute('data-theme')).toBe('dark'));
  });

  it('never measures a width in jsdom, so the demotion loop stays inert (D10)', async () => {
    // useMeasuredWidth returns null without ResizeObserver, and the engine does
    // nothing on null. If this ever changed, the loop would act on a fabricated
    // measurement — the exact failure that made `null` rather than `0` the
    // right unmeasured value.
    expect(typeof ResizeObserver).toBe('undefined');
    const { getByTestId } = renderGate();
    await waitFor(() => getByTestId('workspace-grid'));
    expect(getByTestId('panel-stack').getAttribute('data-slots')).toBe('0');
  });
});
