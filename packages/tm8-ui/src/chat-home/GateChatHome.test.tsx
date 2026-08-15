// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { GateApp } from '../views/GateApp';
import { resetNav } from '../stores/navStore';

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() { return values.size; },
    },
  });
  resetNav();
  /* The URL is state now, and jsdom keeps ONE `window.location` per file. A
     case that navigates leaves its address behind and the next case boots from
     it, because an addressable hash at boot deliberately outranks last-place
     (R3) — so `resetNav()` alone stopped being a reset the day the router was
     mounted. Same class as the localStorage doubles these files already carry,
     one global later. */
  window.location.hash = '';
});

describe('dashboard route', () => {
  it('mounts the merged single home — chat hero inside the HomePage canvas', async () => {
    // Revision 13 (conversation-axis ruling): NOBODY CLICKS TO GET HERE. With
    // no remembered place the shell boots straight onto the conversation
    // surface, because Home stopped being a destination and became the
    // container. The click this case used to make — a "Home" row in the rail —
    // is the exact affordance the ruling removed.
    const view = render(<GateApp />);

    // The merged canvas hosts the chat surface as its hero. The old T5-1
    // triage dashboard stays unmounted.
    expect(await view.findByTestId('home-page')).toBeTruthy();
    expect(await view.findByTestId('chat-home-screen')).toBeTruthy();
    expect(view.queryByTestId('home-screen')).toBeNull();
    // Three sightings, one conversation: the panel row (the inventory), the
    // working-set tab (it is open), and the conversation's own head.
    await waitFor(() =>
      expect(view.getAllByText('Plan the launch sequence')).toHaveLength(3),
    );
    fireEvent.click(view.getByRole('button', { name: /^New chat$/ }));
    expect(await view.findByText(/New conversation — pick a mode/)).toBeTruthy();
  });

  it('offers no door back to a Home that no longer exists — the mark is the one door', async () => {
    const view = render(<GateApp />);
    await view.findByTestId('chat-home-screen');

    // No tab, and no rail row, is labelled Home: `dashboard` belongs to no
    // group now. The tablist is the top row; the rail below renders only the
    // ACTIVE group's contents, and no group owns the surface we are standing
    // on, so there is nothing for it to draw.
    const tabs = view.getByRole('tablist', { name: 'Screens' });
    expect(within(tabs).queryByText('Home')).toBeNull();
    expect(within(tabs).getByRole('tab', { name: 'Work' })).toBeTruthy();

    // The mark is the way back — not a second door, because the tab it
    // replaces was retired in the same change. It never reads as current.
    const mark = view.getByTestId('go-home');
    expect(mark.getAttribute('role')).toBeNull();
    fireEvent.click(mark);
    expect(await view.findByTestId('chat-home-screen')).toBeTruthy();
  });

  it('opens a panel conversation as a tab, and closing the tab leaves the panel whole', async () => {
    const view = render(<GateApp />);
    await view.findByTestId('chat-home-screen');
    const strip = await waitFor(() => view.getByRole('tablist', { name: 'Open conversations' }));

    // Cold start auto-opened the most recent conversation, so the strip is
    // already one tab deep and the panel row it came from is still listed.
    const panelRows = () =>
      [...view.container.querySelectorAll('.tch-thread__title')].map((n) => n.textContent);
    const before = panelRows();
    expect(within(strip).getAllByRole('tab')).toHaveLength(1);

    fireEvent.click(within(strip).getByRole('button', { name: /^Close / }));

    // The tab is gone. THE PANEL IS NOT: closing a tab is not a delete, and
    // the inventory is the panel's, not the working set's.
    expect(view.queryByRole('tablist', { name: 'Open conversations' })).toBeNull();
    expect(panelRows()).toEqual(before);
  });
});
