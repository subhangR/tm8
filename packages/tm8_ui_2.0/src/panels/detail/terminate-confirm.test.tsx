// @vitest-environment jsdom
/**
 * FINDING #2 (audit 2026-08-29) — the panel's one safety verb, made readable
 * and made deliberate.
 *
 *   · U+23FB (⏻) tofus in the system fonts, so the Terminate primary rendered
 *     as an unreadable rectangle. The registry now carries drawn artwork
 *     (`ActionDef.iconArt`) and the bar renders it as an inline SVG, 16px,
 *     stroked in `currentColor` — never the character.
 *   · Terminate dispatched INSTANTLY, one slip away from Close. It now takes a
 *     one-step confirm (`ActionDef.confirm`): the first press arms the control
 *     as "sure?", the second press inside 3s performs, and an ignored arm
 *     expires silently.
 *
 * Both behaviours are REGISTRY DATA plus one consumer — no surface asks
 * `ref === 'terminate'` (§15.2).
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionContext } from '../../domain';
import { getKind, resolveAction } from '../../domain';
import { ActionBar } from './chrome';

const SESSION = '01900000-0000-7000-8000-0000000000e1';

/** A live, running session — the state in which Terminate is offered. */
const liveCtx: ActionContext = {
  entityId: SESSION,
  kind: 'work_session',
  category: 'in_progress',
  liveness: 'live',
} as ActionContext;

function renderBar(onAction = vi.fn()) {
  render(
    <ActionBar
      config={getKind('work_session')}
      ctx={liveCtx}
      onAction={onAction}
      markPrimaries
    />,
  );
  return onAction;
}

describe('the Terminate primary', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is registry-declared as the work_session primary this suite exercises', () => {
    // The harness renders the registry's own declaration, not a hand-built
    // button — if terminate leaves the primaries this suite must go red.
    expect(getKind('work_session').panel.primaries).toContain('terminate');
    const def = resolveAction('terminate');
    expect(def.iconArt).toBeDefined();
    expect(def.confirm).toEqual({ armedLabel: 'sure?', windowMs: 3_000 });
  });

  it('draws an inline SVG power mark, never the tofu character', () => {
    renderBar();
    const button = screen.getByTestId('panel-primary-terminate');
    // The drawn mark: an SVG on the 16-grid, stroked in currentColor.
    const svg = button.querySelector('svg.kit-vicon');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('width')).toBe('16');
    expect(svg!.getAttribute('stroke')).toBe('currentColor');
    // And no U+23FB anywhere in the control.
    expect(button.textContent ?? '').not.toContain('⏻');
    // The word survives as the accessible name and the tooltip.
    expect(button.getAttribute('aria-label')).toBe('Terminate');
  });

  it('arms on the first press instead of terminating, and confirms on the second', () => {
    const onAction = renderBar();
    const button = screen.getByTestId('panel-primary-terminate');

    fireEvent.click(button);
    // First press: nothing dispatched, the control asks the question.
    expect(onAction).not.toHaveBeenCalled();
    expect(button.textContent).toBe('sure?');
    expect(button.getAttribute('data-armed')).toBe('true');
    expect(button.getAttribute('aria-label')).toMatch(/press again to confirm/i);

    fireEvent.click(button);
    // Second press inside the window: the verb performs, once.
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith('terminate');
    // And the arm is spent — the control is back to its resting form.
    expect(button.getAttribute('data-armed')).toBeNull();
  });

  it('lets an ignored arm expire after 3s — the next press arms again, not fires', () => {
    const onAction = renderBar();
    const button = screen.getByTestId('panel-primary-terminate');

    fireEvent.click(button);
    expect(button.getAttribute('data-armed')).toBe('true');

    // React 19 flush semantics: the timer advance runs inside act so the
    // disarm commit lands before the assertions read the DOM.
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(button.getAttribute('data-armed')).toBeNull();
    expect(onAction).not.toHaveBeenCalled();

    // A press after expiry is a FIRST press again.
    fireEvent.click(button);
    expect(onAction).not.toHaveBeenCalled();
    expect(button.getAttribute('data-armed')).toBe('true');
  });

  it('keeps the arm alive inside the window', () => {
    const onAction = renderBar();
    const button = screen.getByTestId('panel-primary-terminate');

    fireEvent.click(button);
    act(() => {
      vi.advanceTimersByTime(2_999);
    });
    expect(button.getAttribute('data-armed')).toBe('true');
    fireEvent.click(button);
    expect(onAction).toHaveBeenCalledWith('terminate');
  });
});
