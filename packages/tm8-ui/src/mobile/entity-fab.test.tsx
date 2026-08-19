// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

import { EntityFab, type EntityFabItem } from './EntityFab';
import { MobileSurfaceProvider } from './surface';

/**
 * WHAT NO TEST IN THIS FILE CLAIMS TO SEE.
 *
 * jsdom loads no stylesheets. It cannot see that the secondary FAB actually
 * sits higher, that the refused row is actually dimmed, that the stack fits on
 * screen or that the mark reads against its circle. Every one of those is a
 * browser question and belongs in a screenshot on the PR. So the offset
 * assertion below checks the ATTRIBUTE the stylesheet keys off, not a pixel —
 * a test that asserted the pixel would be reading a computed style jsdom
 * invented.
 *
 * What these CAN see is the behaviour: what is in the DOM, what fires, and what
 * refuses to.
 */

function mount(ui: ReactElement) {
  /* The provider is the phone. `sheetHost` is irrelevant to this component —
     it portals nothing — but the provider's shape requires it, and passing the
     container keeps the value honest rather than null-and-unused. */
  return render(<MobileSurfaceProvider sheetHost={document.body}>{ui}</MobileSurfaceProvider>);
}

const LIVE: EntityFabItem = { id: 'connections', label: 'Connections', count: 3 };

describe('EntityFab / desktop', () => {
  /**
   * THE TEST THAT KEEPS EVERY BRANCH IN THIS COMPONENT OFF THE DESKTOP.
   *
   * No provider ⇒ `useMobileSurface()` returns the DESKTOP value ⇒ null. The
   * desktop shell is in daily use; this is the assertion that says a host may
   * mount `<EntityFab>` unconditionally beside its desktop chrome and change
   * nothing there.
   */
  it('mounts nothing at all without the phone surface', () => {
    const { container } = render(<EntityFab items={[LIVE]} label="Task actions" />);
    expect(container.firstChild).toBeNull();
  });
});

describe('EntityFab / trigger', () => {
  it('carries its accessible name and its popup state', () => {
    const { getByTestId } = mount(<EntityFab items={[LIVE]} label="Task actions" />);
    const trigger = getByTestId('entity-fab');
    expect(trigger.getAttribute('aria-label')).toBe('Task actions');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('draws the Möbius mark by default and a caller’s own face when given one', () => {
    const { container, rerender } = mount(<EntityFab items={[LIVE]} label="Task actions" />);
    expect(container.querySelector('[data-testid="ribbon-mark"]')).not.toBeNull();

    rerender(
      <MobileSurfaceProvider sheetHost={document.body}>
        <EntityFab items={[LIVE]} label="Surfaces" face={<span>◫</span>} />
      </MobileSurfaceProvider>,
    );
    expect(container.querySelector('[data-testid="ribbon-mark"]')).toBeNull();
  });

  /**
   * The mark must not turn. It sits on screen for as long as the reader is on
   * the entity, and `RibbonMark` rebuilds its whole polygon band through React
   * every frame — so a turning mark here burns a rAF for as long as the app is
   * open, and asks the eye to track something that never resolves.
   *
   * THE ASSERTION IS THE rAF, and the obvious alternative does not work. Two
   * mounts compared for identical geometry LOOKS like a test of this and is
   * not: with `animated` true, `useLoopTime` still starts at t = 0 and jsdom
   * advances no frames inside a synchronous test, so both mounts agree either
   * way. Measured — that version passed with `animated={false}` deleted.
   * Subscribing is the one thing `animated` decides that is observable here.
   */
  it('holds the mark still rather than burning a frame for the whole session', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    mount(<EntityFab items={[LIVE]} label="Task actions" />);
    expect(raf).not.toHaveBeenCalled();
    raf.mockRestore();
  });

  it('spends a glyph-size quad budget, not the full-size one', () => {
    const { container } = mount(<EntityFab items={[LIVE]} label="Task actions" />);
    const quads = container.querySelectorAll('polygon').length;
    expect(quads).toBeGreaterThanOrEqual(3);
    expect(quads).toBeLessThan(150);
  });
});

describe('EntityFab / menu', () => {
  it('opens a menu whose rows are addressable by id, not by label', () => {
    const { getByTestId, container } = mount(
      <EntityFab
        items={[LIVE, { id: 'discussion', label: 'Discussion', count: 0 }]}
        label="Task actions"
      />,
    );
    fireEvent.click(getByTestId('entity-fab'));

    const menu = container.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(menu?.getAttribute('aria-label')).toBe('Task actions');
    expect(Array.from(container.querySelectorAll('[data-fab-item]')).map((el) =>
      el.getAttribute('data-fab-item'),
    )).toEqual(['connections', 'discussion']);
    expect(container.querySelectorAll('[role="menuitem"]')).toHaveLength(2);
  });

  /**
   * ABSENT IS NOT ZERO. A Discussion with no messages must say `0` rather than
   * lose its counter — a truthiness check would render the two states
   * identically and the reader could not tell "no messages" from "we did not
   * count".
   */
  it('renders a zero count and omits an absent one', () => {
    const { getByTestId, container } = mount(
      <EntityFab
        items={[
          { id: 'discussion', label: 'Discussion', count: 0 },
          { id: 'edit', label: 'Edit' },
        ]}
        label="Task actions"
      />,
    );
    fireEvent.click(getByTestId('entity-fab'));

    const counts = Array.from(container.querySelectorAll('.efab__count')).map((el) => el.textContent);
    expect(counts).toEqual(['0']);
  });

  it('selects a live row, then closes', () => {
    const onSelect = vi.fn();
    const { getByTestId, container } = mount(
      <EntityFab items={[{ ...LIVE, onSelect }]} label="Task actions" />,
    );
    fireEvent.click(getByTestId('entity-fab'));
    fireEvent.click(container.querySelector('[data-fab-item="connections"]')!);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  /**
   * MAIN ROWS FIRST, END ROWS AFTER — asserted on the order rather than on the
   * hairline, because the hairline is a border and jsdom has no borders. The
   * component partitions rather than trusting the caller's order, so the
   * divider the stylesheet draws on the first end row is always the boundary
   * between the groups.
   */
  it('sinks the end group below the main one whatever order it arrives in', () => {
    const { getByTestId, container } = mount(
      <EntityFab
        items={[
          { id: 'transfer', label: 'Transfer', group: 'end' },
          { id: 'run', label: 'Run' },
          { id: 'expand', label: 'Open full view', group: 'end' },
          { id: 'edit', label: 'Edit' },
        ]}
        label="Task actions"
      />,
    );
    fireEvent.click(getByTestId('entity-fab'));

    expect(Array.from(container.querySelectorAll('[data-fab-item]')).map((el) =>
      el.getAttribute('data-fab-item'),
    )).toEqual(['run', 'edit', 'transfer', 'expand']);
    expect(container.querySelectorAll('.efab__row--end')).toHaveLength(2);
  });
});

describe('EntityFab / refusal', () => {
  /**
   * DISABLED-WITH-REASON, NEVER ENABLED-INERT, NEVER HIDDEN (house rule 1, and
   * `chrome.tsx`'s R5 #9). A verb that cannot be performed is present, dimmed,
   * carrying its reason — and this menu may not be the one surface in the
   * product that disagrees.
   *
   * `aria-disabled` and not the `disabled` attribute: a natively disabled
   * button leaves the tab order, so a keyboard reader can never reach it and
   * therefore never learns WHY, which defeats the treatment entirely.
   */
  it('renders a refused verb, dimmed, carrying its reason, and refuses to fire it', () => {
    const onSelect = vi.fn();
    const { getByTestId, container } = mount(
      <EntityFab
        items={[{ id: 'run', label: 'Run', reason: 'This action isn’t connected yet', onSelect }]}
        label="Task actions"
      />,
    );
    fireEvent.click(getByTestId('entity-fab'));

    const row = container.querySelector('[data-fab-item="run"]')!;
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.getAttribute('role')).toBe('menuitem');

    /* The reason is IN THE DOM and wired to the row, so it is announced on
       focus rather than only drawn. */
    const described = row.getAttribute('aria-describedby');
    expect(described).toBeTruthy();
    /* `getElementById`, not a selector: `useId` mints ids like `:r3:`, which are
       not valid CSS identifiers and would need escaping to be queried at all. */
    expect(document.getElementById(described!)?.textContent).toBe('This action isn’t connected yet');

    fireEvent.click(row);
    expect(onSelect).not.toHaveBeenCalled();
    /* And it did not close either — a refusal that dismissed the menu would
       read as an action that had been taken. */
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
  });
});

describe('EntityFab / dismissal', () => {
  it('closes on the ✕, and returns focus to the trigger', () => {
    const { getByTestId, container } = mount(<EntityFab items={[LIVE]} label="Task actions" />);
    const trigger = getByTestId('entity-fab');
    fireEvent.click(trigger);
    fireEvent.click(trigger);

    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on the scrim', () => {
    const { getByTestId, container } = mount(<EntityFab items={[LIVE]} label="Task actions" />);
    fireEvent.click(getByTestId('entity-fab'));
    fireEvent.click(container.querySelector('.efab__scrim')!);

    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(getByTestId('entity-fab'));
  });

  /**
   * A phone has no Escape key. This is here because the phone shell is
   * reachable on any coarse-pointer device — several of which have keyboards —
   * and because every other cover on this shell closes on it. `MobileSheet`
   * takes ONE `onDismiss` for exactly this reason: given one callback per
   * gesture, a host wires the button and leaves Escape silently dead.
   */
  it('closes on Escape', () => {
    const { getByTestId, container } = mount(<EntityFab items={[LIVE]} label="Task actions" />);
    fireEvent.click(getByTestId('entity-fab'));
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(getByTestId('entity-fab'));
  });

  /* The listener is bound only while the menu is up. A capture-phase Escape
     handler that outlived its menu would swallow the key from the surface
     underneath, and one press would close two things. */
  it('does not hold the Escape key while it is closed', () => {
    const onEscape = vi.fn();
    document.addEventListener('keydown', onEscape);
    mount(<EntityFab items={[LIVE]} label="Task actions" />);
    fireEvent.keyDown(document, { key: 'Escape' });
    document.removeEventListener('keydown', onEscape);
    expect(onEscape).toHaveBeenCalledTimes(1);
  });
});

describe('EntityFab / slots', () => {
  /**
   * THE OFFSET IS A STYLESHEET FACT AND JSDOM LOADS NO STYLESHEETS. What is
   * assertable here is the hook the stylesheet keys off — the attribute and the
   * modifier class — and that is what the acceptance criterion asks for. A test
   * claiming to have measured the two FABs at different heights would be a lie.
   */
  it('marks a secondary FAB so the stylesheet can lift it', () => {
    const primary = mount(<EntityFab items={[LIVE]} label="Task actions" />);
    const secondary = mount(<EntityFab items={[LIVE]} label="Surfaces" slot="secondary" />);

    const rootOf = (c: HTMLElement) => c.querySelector('[data-fab-slot]')!;
    expect(rootOf(primary.container).getAttribute('data-fab-slot')).toBe('primary');
    expect(rootOf(secondary.container).getAttribute('data-fab-slot')).toBe('secondary');
    expect(rootOf(primary.container).className).not.toContain('efab--secondary');
    expect(rootOf(secondary.container).className).toContain('efab--secondary');
  });

  it('takes a caller’s test id so two FABs on one screen are separable', () => {
    const { getByTestId } = mount(
      <EntityFab items={[LIVE]} label="Surfaces" slot="secondary" testId="ws-surface-fab" />,
    );
    expect(getByTestId('ws-surface-fab').getAttribute('aria-label')).toBe('Surfaces');
  });
});
