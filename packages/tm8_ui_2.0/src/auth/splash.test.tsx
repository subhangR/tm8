// @vitest-environment jsdom
/**
 * THE CURTAIN'S CLOCK — the three claims `AuthSplash`'s docblock makes.
 *
 * The floor is the only part of this feature that costs anybody anything: it
 * is added time, deliberately, on every page load. So the promises that make
 * that acceptable are the ones worth pinning — it goes away on its own, it
 * goes away sooner if you touch anything, and it never runs at all for a
 * viewer who has asked for stillness.
 *
 * WHY THE FLOOR IS ASSERTED THROUGH `SPLASH_FLOOR_MS` AND NOT AS 2500. The
 * number is a product ruling (six seconds was asked for, 2.5 was the answer)
 * and a test that hard-codes it turns the next ruling into a test failure. The
 * SHAPE is what this file owns: that a floor exists, that the curtain outlives
 * it by the lift, and that input cuts it short.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AuthSplash, SPLASH_FLOOR_MS, SPLASH_LIFT_MS, useSplashCurtain } from './AuthSplash';

/** The component under test is a hook plus a view, so the harness is both. */
function Curtain({ active = false }: { active?: boolean }) {
  const phase = useSplashCurtain(active);
  return <AuthSplash phase={phase} detail="STARTING UP" />;
}

function tick(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

let reduced = false;

beforeEach(() => {
  vi.useFakeTimers();
  reduced = false;
  // jsdom has no matchMedia. Supplying one is not a convenience here: the
  // reduced-motion branch is a claim this file has to be able to test.
  vi.stubGlobal(
    'matchMedia',
    (q: string) =>
      ({
        matches: q.includes('prefers-reduced-motion') ? reduced : false,
        media: q,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the splash holds, then goes', () => {
  it('is up on the first paint', () => {
    render(<Curtain />);
    expect(screen.getByTestId('auth-splash').dataset.phase).toBe('up');
  });

  it('is still up one tick before the floor is done', () => {
    render(<Curtain />);
    tick(SPLASH_FLOOR_MS - 1);
    expect(screen.getByTestId('auth-splash').dataset.phase).toBe('up');
  });

  it('lifts once the floor elapses, and is gone after the fade', () => {
    render(<Curtain />);
    tick(SPLASH_FLOOR_MS);
    expect(screen.getByTestId('auth-splash').dataset.phase).toBe('lifting');
    tick(SPLASH_LIFT_MS);
    // Gone means gone from the DOM, not transparent: a curtain left mounted
    // would keep a fixed layer over every click in the app underneath.
    expect(screen.queryByTestId('auth-splash')).toBeNull();
  });

  it('outstays a wait that is still running, however long the floor was', () => {
    render(<Curtain active />);
    tick(SPLASH_FLOOR_MS * 4);
    expect(screen.getByTestId('auth-splash').dataset.phase).toBe('up');
  });
});

describe('the floor governs the eye, never the hand', () => {
  it('a key press retires it early', () => {
    render(<Curtain />);
    act(() => {
      fireEvent.keyDown(window, { key: 'a' });
    });
    expect(screen.getByTestId('auth-splash').dataset.phase).toBe('lifting');
  });

  it('a click retires it early', () => {
    render(<Curtain />);
    act(() => {
      fireEvent.pointerDown(window);
    });
    expect(screen.getByTestId('auth-splash').dataset.phase).toBe('lifting');
  });

  it('input cannot pull it off a wait that has not finished', () => {
    // The escape hatch skips the FLOOR. It must not skip the work: cutting to
    // a sign-in card the gate has not decided on yet is the flash the gate's
    // blank exists to prevent.
    render(<Curtain active />);
    act(() => {
      fireEvent.pointerDown(window);
    });
    expect(screen.getByTestId('auth-splash').dataset.phase).toBe('up');
  });
});

describe('reduced motion', () => {
  it('never raises the curtain at all', () => {
    // Not "shows a still picture of a wait" — asking for stillness and being
    // given a static logo for two and a half seconds is a worse answer than
    // the form.
    reduced = true;
    render(<Curtain />);
    expect(screen.queryByTestId('auth-splash')).toBeNull();
  });
});

describe('what it announces', () => {
  it('is a live status region while it is up, naming the stage', () => {
    render(<Curtain />);
    const el = screen.getByTestId('auth-splash');
    expect(el.getAttribute('role')).toBe('status');
    expect(el.getAttribute('aria-live')).toBe('polite');
    expect(el.textContent).toContain('STARTING UP');
  });

  it('stops announcing once the thing it announced is over', () => {
    render(<Curtain />);
    tick(SPLASH_FLOOR_MS);
    const el = screen.getByTestId('auth-splash');
    expect(el.getAttribute('role')).toBeNull();
    expect(el.getAttribute('aria-hidden')).toBe('true');
  });
});
