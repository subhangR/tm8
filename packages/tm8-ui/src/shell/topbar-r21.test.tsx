// @vitest-environment jsdom
/**
 * REVISION 21 — the claims jsdom CAN carry.
 *
 * READ THIS BEFORE ADDING A LAYOUT ASSERTION HERE. jsdom loads no stylesheets
 * and has no layout engine, so nothing in this file can see the defect the
 * revision exists to fix: overflow, clipping, centring, the container-query
 * ladder and the `zoom: 1.1` budget are all invisible here. Those are measured
 * in `e2e/topbar-audit-harness.tsx` with a real browser, and an assertion added
 * here that claims to check them would be a false negative waiting to happen.
 *
 * What this file CAN hold is the STRUCTURE the layout hangs off, and the one
 * behavioural rule the redesign introduced: where the three utilities render.
 */
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { SpaceTabBar } from './SpaceTabBar';

const renderBar = (props: Partial<ComponentProps<typeof SpaceTabBar>> = {}) =>
  render(
    <div className="cv2-root">
      <SpaceTabBar {...props} />
    </div>,
  );

describe('R21 — the three-zone row', () => {
  it('renders exactly three zones, in lead / centre / trail order', () => {
    const { container } = renderBar({ tabs: [{ id: 'home', label: 'Home' }] });
    const zones = Array.from(container.querySelectorAll('.shell-tabbar__zone'));
    expect(zones).toHaveLength(3);
    expect(zones[0]!.className).toContain('shell-tabbar__zone--lead');
    expect(zones[1]!.className).toContain('shell-tabbar__zone--centre');
    expect(zones[2]!.className).toContain('shell-tabbar__zone--trail');
  });

  /* The spacer was the flex-centring hack. Its ABSENCE is the assertion: a
     regression that restores it would restore the bug item 4 named, and would
     do it silently, because a spacer inside a grid track simply does nothing
     visible until someone looks at where the tabs sit. */
  it('carries NO flex spacer — the grid centres the tabs, not a filler element', () => {
    const { container } = renderBar();
    expect(container.querySelector('.shell-tabbar__spacer')).toBeNull();
  });

  it('the tab row lives in the centre zone', () => {
    const { container } = renderBar({ tabs: [{ id: 'home', label: 'Home' }] });
    const centre = container.querySelector('.shell-tabbar__zone--centre');
    expect(centre?.querySelector('[role="tablist"]')).not.toBeNull();
  });

  /* THE UI-2.0 DOOR IS GONE — item 2, "remove this entirely", ruled again by
     the owner on 2026-09-07 after seeing the overflow fixed and still wanting
     the control out.

     THIS ASSERTION REPLACES ONE THAT CLAIMED THE OPPOSITE, and it is written as
     a DOM check rather than left to the type system on purpose: `uiSwitchSlot`
     was removed from `SpaceTabBarProps`, so a host cannot pass it and TypeScript
     would catch the attempt — but a regression that re-adds the prop AND the
     render would typecheck cleanly. Only this test would fail. */
  it('renders NO UI-2.0 door, and no slot for one', () => {
    const { container } = renderBar({ tabs: [{ id: 'home', label: 'Home' }] });
    expect(container.querySelector('.shell-tabbar__uiswitch')).toBeNull();
    expect(container.querySelector('a[href^="/ui-2.0"]')).toBeNull();
    expect(container.textContent).not.toMatch(/UI 2\.0/i);
  });
});

describe('R21 — where the three utilities render (finding #8)', () => {
  const withMenu = { accountSlot: <div data-testid="the-account-menu">menu</div> };

  it('with an account menu, the bar hands inbox, prompts and copy link over', () => {
    const { queryByTestId, container } = renderBar({
      ...withMenu,
      onOpenInbox: vi.fn(),
      onOpenPrompts: vi.fn(),
      shareSlot: <button data-testid="the-share-control">Copy link</button>,
    });
    expect(queryByTestId('the-account-menu')).not.toBeNull();
    expect(queryByTestId('open-inbox')).toBeNull();
    expect(queryByTestId('open-prompts')).toBeNull();
    expect(queryByTestId('the-share-control')).toBeNull();
    // The palette stays: it is how those three are reached by name.
    expect(container.querySelector('.shell-tabbar__palette')).not.toBeNull();
  });

  /* THE STATE THE FIRST DESIGN MISSED. `AccountMenu` renders nothing without a
     gate, so `accountSlot` is undefined for a viewer with no account, and the
     bar falls back to an avatar whose only verb is "Toggle theme". Moving the
     three utilities unconditionally would have made all of them unreachable
     from chrome in that state — a real loss of functionality, in the name of
     losing none. */
  it('with NO account menu, the bar keeps all three — they have nowhere else to go', () => {
    const onOpenInbox = vi.fn();
    const onOpenPrompts = vi.fn();
    const { getByTestId, queryByTestId } = renderBar({
      onOpenInbox,
      onOpenPrompts,
      shareSlot: <button data-testid="the-share-control">Copy link</button>,
    });
    expect(queryByTestId('the-account-menu')).toBeNull();

    fireEvent.click(getByTestId('open-inbox'));
    expect(onOpenInbox).toHaveBeenCalledOnce();
    fireEvent.click(getByTestId('open-prompts'));
    expect(onOpenPrompts).toHaveBeenCalledOnce();
    expect(queryByTestId('the-share-control')).not.toBeNull();
  });

  it('and the bell keeps its D28 posture there: announced, focusable, refused', () => {
    const bell = renderBar().getByTestId('open-inbox') as HTMLButtonElement;
    expect(bell.getAttribute('aria-disabled')).toBe('true');
    expect(bell.disabled).toBe(false);
    bell.focus();
    expect(document.activeElement).toBe(bell);
  });

  /* No state draws a verb twice. This is the invariant that makes the
     conditional above safe rather than clever. */
  it('never draws inbox in both places at once', () => {
    const { container } = renderBar({ ...withMenu, onOpenInbox: vi.fn() });
    expect(container.querySelectorAll('[data-testid="open-inbox"]')).toHaveLength(0);
    const bare = renderBar({ onOpenInbox: vi.fn() });
    expect(bare.container.querySelectorAll('[data-testid="open-inbox"]')).toHaveLength(1);
  });
});
