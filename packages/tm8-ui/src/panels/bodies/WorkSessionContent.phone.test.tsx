// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { MobileSurfaceProvider } from '../../mobile';
import { WorkSessionContent } from './WorkSessionContent';

/**
 * THE PHONE ARRANGEMENT OF THE RUN SURFACE — DEF-029, and the transcript-first
 * ruling that rides with it.
 *
 * WHAT A TEST CAN AND CANNOT SETTLE HERE, stated up front because this program
 * has been burned by the difference. jsdom has NO LAYOUT: it cannot tell you
 * that a chip is 44px, that a row does not overflow, or that nothing is sliced.
 * Those are the build service's, from pixels. What it CAN settle is the part a
 * screenshot cannot: which surfaces are OFFERED, which one opens by default,
 * and whether the three that are not offered are stated or silently dropped.
 * The second question is the one absence-measuring-as-health keeps answering
 * wrong, and it has no pixel signature at all — a surface that vanished and a
 * surface that was never there photograph identically.
 *
 * The fork is the HOST's, so every phone case here mounts the provider. Without
 * it `useMobileSurface()` returns DESKTOP, which is exactly why the desktop
 * suite next door needs no changes.
 */
const SESSION = '01900000-0000-7000-8000-0000000000c1';

function phone(node: ReactNode) {
  return render(<MobileSurfaceProvider sheetHost={null}>{node}</MobileSurfaceProvider>);
}

describe('WorkSessionContent on a phone', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
    } satisfies Storage;
    Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  });

  it('offers two surfaces, transcript first, and opens on the transcript', () => {
    phone(
      <WorkSessionContent
        sessionId={SESSION}
        profile={null}
        terminal={<div>native terminal</div>}
        transcript={<div>agent transcript</div>}
        debug={<div>debug journal</div>}
        git={<div>git rail</div>}
        graph={<div>graph canvas</div>}
      />,
    );

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Transcript',
      'Terminal',
    ]);
    expect(screen.getByTestId('work-session-content').dataset.surface).toBe('transcript');
    /* Two fields, not one: `data-surface` says what is SHOWING and
       `data-arrangement` says which SET was on offer to show it. A capture that
       could only read the first could not tell a phone that opened on the
       transcript from a desktop that happened to. */
    expect(screen.getByTestId('work-session-content').dataset.arrangement).toBe('phone');
  });

  /**
   * THE ONE THIS FILE EXISTS FOR.
   *
   * Removing three surfaces is defensible. Removing them QUIETLY is the DEF-003
   * pathology — the phone had no account menu, no space switcher and no sign-out
   * for months, and every tap census scored those screens as passing, because
   * absence measures as health. If this assertion is ever deleted along with the
   * marker, nothing else in the suite and nothing in the instrument will notice.
   */
  it('states the three surfaces it refuses rather than dropping them silently', () => {
    phone(
      <WorkSessionContent
        sessionId={SESSION}
        profile={null}
        terminal={<div>native terminal</div>}
        transcript={<div>agent transcript</div>}
      />,
    );

    const marker = screen.getByTestId('work-session-surface-refused-marker');
    expect(marker.textContent).toContain('Git');
    expect(marker.textContent).toContain('Debug');
    expect(marker.textContent).toContain('Graph');
    /* It is a STATEMENT, not a fourth tab: a screen reader walking the tablist
       must not be offered something it cannot select. */
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  it('answers a route that names a refused surface by naming THAT surface', () => {
    phone(
      <WorkSessionContent
        sessionId={SESSION}
        profile={null}
        requestedSurface="git"
        terminal={<div>native terminal</div>}
        transcript={<div>agent transcript</div>}
        git={<div data-testid="git-rail">git rail</div>}
      />,
    );

    const refusal = screen.getByTestId('work-session-surface-refused');
    expect(refusal.dataset.surfaceRefused).toBe('git');
    /* The card names what was ASKED FOR. A generic "not available here" would
       be the vague refusal DEF-012 was filed against. */
    expect(refusal.textContent).toContain('Git');

    /* The refused surface is not selected — the switch has no tab for it, and a
       tablist announcing a selection nobody can see is worse than the refusal.
       The session stays open and readable underneath. */
    expect(screen.getByTestId('work-session-content').dataset.surface).toBe('transcript');
    /* And its body never mounts, so its poll never starts. */
    expect(screen.queryByTestId('git-rail')).toBeNull();
  });

  /**
   * DEF-029's mechanism, pinned. The control is not under-sized in `panels.css`
   * — `.pn-surface-switch__tab` has declared `min-height: 44px` all along. The
   * `--bar` modifier strips it to 22px so five chips can ride a fixed 30px row.
   * So the fix is DECLINING THE SLOT, and this is the assertion that the fix is
   * still in place: with the modifier absent the base floor is simply in force.
   *
   * A layout assertion cannot be made here — jsdom has no boxes — so this pins
   * the CAUSE and the build service grades the effect. Named that way on
   * purpose: "the modifier is absent" and "the chip measures 44px" are two
   * claims and only one of them lives in this file.
   */
  it('declines the panel bar slot, so the chips keep their own 44px floor', () => {
    const slot = document.createElement('div');
    document.body.append(slot);

    phone(
      <WorkSessionContent
        sessionId={SESSION}
        profile={null}
        switchSlot={slot}
        terminal={<div>native terminal</div>}
        transcript={<div>agent transcript</div>}
      />,
    );

    const tablist = screen.getByTestId('work-session-surface-switch');
    /* The ROW carries the styling and the arrangement stamp; the inner element
       carries the tablist role, so the refusal marker can sit in the row
       without becoming a non-tab child of a tablist. */
    const row = tablist.closest('.pn-surface-switch');
    expect(row).not.toBeNull();
    expect(row?.className).not.toContain('pn-surface-switch--bar');
    expect((row as HTMLElement).dataset.arrangement).toBe('phone-row');
    /* Not portalled: it is a sibling of the surfaces, not a child of the bar. */
    expect(slot.contains(tablist)).toBe(false);
  });

  /**
   * THE CONTROL ON THE CONTROL. Every assertion above would also pass on a
   * component that had simply been broken for the desktop too, so one case
   * proves the fork is a fork: no provider, five tabs, terminal default, and
   * the marker absent.
   */
  it('leaves the desktop arrangement alone — five surfaces, terminal first, no marker', () => {
    render(
      <WorkSessionContent
        sessionId={SESSION}
        profile={null}
        terminal={<div>native terminal</div>}
        transcript={<div>agent transcript</div>}
      />,
    );

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Terminal',
      'Transcript',
      'Git',
      'Debug',
      'Graph',
    ]);
    expect(screen.getByTestId('work-session-content').dataset.surface).toBe('terminal');
    expect(screen.getByTestId('work-session-content').dataset.arrangement).toBe('desktop');
    expect(screen.queryByTestId('work-session-surface-refused-marker')).toBeNull();
  });
});
