// @vitest-environment jsdom
/**
 * WAVE 3 — the pin control (the panel's one wholly dead prop set, rendered at
 * last) and the header polish (the mono id tail; the breadcrumb derived from
 * data the detail already carries).
 *
 * The pin's ABSENCE on unwired mounts is pinned in panels.test.tsx
 * (`[aria-label="Pin panel"]` null in both window-control suites); this file
 * holds the PRESENT arms — live, pressed, and refused-with-reason.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import type { EntityDetail } from '@tm8/contract';
import { REASONS as DOMAIN_REASONS, type ActionContext } from '../../domain';
import {
  FIXTURE_SPACE_ID,
  fixtureDetails,
  presenceHollowReason,
  taskUuidTitle,
} from '../../fixtures';
import { EntityDetailPanel, type DetailReasons } from '../index';

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

const REASONS: DetailReasons = {
  presenceHollow: presenceHollowReason,
  versionHistory: DOMAIN_REASONS.versionHistoryDeferred,
  provenanceHollow: 'Session provenance is not recorded yet.',
  shareUnavailable: 'not in the stamped seam',
  withdrawUnavailable: 'not in the stamped seam',
};

const TASK: EntityDetail = fixtureDetails[taskUuidTitle.id]!;

function panel(over: Partial<React.ComponentProps<typeof EntityDetailPanel>> = {}) {
  return render(<EntityDetailPanel detail={TASK} reasons={REASONS} ctx={ctx} {...over} />);
}

describe('the pin — rendered at last, in the window-controls cluster', () => {
  it('renders live where the host wires onPin, and presses through to it', () => {
    const onPin = vi.fn();
    const { getByTestId } = panel({ onPin, pinned: false });
    const pin = getByTestId('panel-pin');
    expect(pin.getAttribute('aria-label')).toBe('Pin panel');
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(pin);
    expect(onPin).toHaveBeenCalledTimes(1);
  });

  it('a PINNED panel shows the pressed state and offers the way back', () => {
    const onPin = vi.fn();
    const { getByTestId } = panel({ onPin, pinned: true });
    const pin = getByTestId('panel-pin');
    expect(pin.getAttribute('aria-pressed')).toBe('true');
    expect(pin.getAttribute('aria-label')).toBe('Unpin panel');
    fireEvent.click(pin);
    // The same handler unpins — WorkspaceView's onPin branches on nav state.
    expect(onPin).toHaveBeenCalledTimes(1);
  });

  it('an admission refusal renders disabled-with-reason, never a live pin', () => {
    const onPin = vi.fn();
    const refusal = 'Not enough width for another pinned panel — close one first';
    const { queryByTestId, getByLabelText } = panel({
      onPin,
      pinned: false,
      pinRefusal: refusal,
    });
    expect(queryByTestId('panel-pin')).toBeNull();
    const refused = getByLabelText('Pin panel');
    expect(refused.getAttribute('aria-disabled')).toBe('true');
    // The reason is reachable (tooltip form), and the click goes nowhere.
    expect(refused.textContent).toMatch(/Not enough width/);
    fireEvent.click(refused);
    expect(onPin).not.toHaveBeenCalled();
  });

  it('the refusal never applies to UN-pinning — a pinned panel keeps a live pin', () => {
    // A full stack must be able to release its own columns: WorkspaceView
    // sends `pinRefusal: undefined` when pinned, but the chrome guards the
    // combination anyway rather than trusting every future host to.
    const onPin = vi.fn();
    const { getByTestId } = panel({ onPin, pinned: true, pinRefusal: 'stack is full — close one' });
    fireEvent.click(getByTestId('panel-pin'));
    expect(onPin).toHaveBeenCalledTimes(1);
  });
});

describe('the header polish — the id tail and the data-derived breadcrumb', () => {
  it('draws the id LAST-4, uppercase, in the graph card grammar', () => {
    const { container } = panel();
    const ref = container.querySelector('.pn-header__ref');
    expect(ref?.textContent).toBe(TASK.id.slice(-4).toUpperCase());
    // Identity is corroboration, not name: the full id stays a grid cell.
    expect(ref?.getAttribute('aria-hidden')).toBe('true');
  });

  it('derives the breadcrumb from hierarchy.path the detail already carries', () => {
    const { container } = panel();
    expect(TASK.hierarchy.path.length).toBeGreaterThan(0);
    expect(container.querySelector('.pn-crumb')?.textContent).toBe(
      TASK.hierarchy.path.map((ancestor) => ancestor.title).join(' › '),
    );
  });

  it('an entity with no ancestors keeps no crumb line — absence is not a place', () => {
    const rootless: EntityDetail = {
      ...TASK,
      hierarchy: { ...TASK.hierarchy, parent: null, path: [] },
    };
    const { container } = panel({ detail: rootless });
    expect(container.querySelector('.pn-crumb')).toBeNull();
  });

  it('a host-passed breadcrumb still wins over the derivation', () => {
    const { container } = panel({ breadcrumb: 'somewhere › else' });
    expect(container.querySelector('.pn-crumb')?.textContent).toBe('somewhere › else');
  });
});
