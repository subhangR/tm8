// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
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

  /**
   * THE ARRIVAL THAT ACTUALLY HAPPENS, and the reason this case exists at all.
   *
   * I wrote the refusal card reading `requestedSurface` and then checked whether
   * that could ever be non-null on this shell. It cannot: `EntityView` is the
   * only host the phone mounts, and it holds `contentSurfaces` in COMPONENT
   * STATE — the navStore's route value reaches `nav.surfaceOf`, i.e.
   * WorkspaceView, which has no phone arrangement. So the route arm is correct
   * and, today, dead code on a phone.
   *
   * The PREFERENCE arm is the one that fires, and it is the likelier arrival
   * anyway: read a session's Git rail on a desktop, open the same session on
   * your phone. Without this the reader lands on the transcript with no
   * explanation of why the surface they left is gone — which is the silent
   * removal this whole arrangement exists to avoid.
   */
  it('names the refusal for a viewer arriving with a refused surface in their stored preference', () => {
    window.localStorage.setItem(`tm8:work-session-surface:v1:member-a:${SESSION}`, 'git');

    phone(
      <WorkSessionContent
        sessionId={SESSION}
        viewerMemberId="member-a"
        profile={null}
        terminal={<div>native terminal</div>}
        transcript={<div>agent transcript</div>}
        git={<div data-testid="git-rail">git rail</div>}
      />,
    );

    const refusal = screen.getByTestId('work-session-surface-refused');
    expect(refusal.dataset.surfaceRefused).toBe('git');
    expect(screen.getByTestId('work-session-content').dataset.surface).toBe('transcript');
    expect(screen.queryByTestId('git-rail')).toBeNull();

    /* And it goes once the viewer has chosen for themselves — the card answers
       "why am I not where I asked to be", and they have stopped asking. */
    fireEvent.click(screen.getByRole('tab', { name: 'Terminal' }));
    expect(screen.queryByTestId('work-session-surface-refused')).toBeNull();
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
   * USER RULING 2026-08-29 — "the terminal and transcript tab is taking too
   * much height, just make them icons and put it on the tab bar above to the
   * right end."
   *
   * WHAT THIS TEST USED TO PIN, AND WHY IT NO LONGER DOES. It read "declines
   * the panel bar slot, so the chips keep their own 44px floor" and asserted
   * `phone-row` — DEF-029's fix, which bought the 44px floor by spending a
   * ~56px band of its own above the terminal. The ruling above outranks that
   * trade on the axis it gave away: the band cost more than the floor was
   * worth on an 844px screen.
   *
   * The slot the phone is handed is NOT `.pn-panelbar` — `TabStrip` draws no
   * bar on this shell at all. It is the identity row's trailing slot, a row the
   * panel already pays for. So this pins the new mechanism in the same shape
   * the old one was pinned: the CAUSE lives here (portalled, marks not words),
   * and the build service still grades the effect in pixels.
   */
  it('rides the head row as marks when a slot is offered', () => {
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
    const row = tablist.closest('.pn-surface-switch');
    expect(row).not.toBeNull();
    /* The desktop's bar modifier is still not what happens here — the head row
       arrangement has its own stamp and its own rules. */
    expect(row?.className).not.toContain('pn-surface-switch--bar');
    expect((row as HTMLElement).dataset.arrangement).toBe('phone-head');
    /* Portalled INTO the slot: that is what "on the row above" means. */
    expect(slot.contains(tablist)).toBe(true);
    /* Icons, not words — but the word is still the accessible name, so a
       screen reader and `getByRole('tab', { name })` hear it unchanged. */
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('aria-label'))).toEqual(['Transcript', 'Terminal']);
    expect(tabs.every((t) => t.textContent === '')).toBe(true);
    expect(tabs.every((t) => t.className.includes('pn-surface-switch__tab--mark'))).toBe(true);
    /* The refusal is still PRESENT and still carries its reason — the three
       names moved from its face to its accessible name, not off the screen. */
    const marker = screen.getByTestId('work-session-surface-refused-marker');
    expect(marker.dataset.form).toBe('mark');
    expect(
      marker.querySelector('[data-testid="disabled-with-reason"]')?.getAttribute('aria-label'),
    ).toBe('Git · Debug · Graph — not on a phone');
  });

  /**
   * THE SLOT-LESS PHONE STILL GETS ITS OWN ROW, with words and the 44px floor.
   * That is what the standalone tests render and what any host that draws no
   * head would get, so DEF-029's arrangement is retained rather than deleted —
   * the ruling moved the hosted case, not every case.
   */
  it('keeps the words-in-its-own-row arrangement when no slot is offered', () => {
    phone(
      <WorkSessionContent
        sessionId={SESSION}
        profile={null}
        terminal={<div>native terminal</div>}
        transcript={<div>agent transcript</div>}
      />,
    );

    const row = screen.getByTestId('work-session-surface-switch').closest('.pn-surface-switch');
    expect((row as HTMLElement).dataset.arrangement).toBe('phone-row');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Transcript',
      'Terminal',
    ]);
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
