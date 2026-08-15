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
    // Revision 14: the Chats TAB leads here, and with no remembered place the
    // shell also boots straight onto it. Both doors, one destination.
    const view = render(<GateApp />);

    // The merged canvas hosts the chat surface as its hero. The old T5-1
    // triage dashboard stays unmounted.
    expect(await view.findByTestId('home-page')).toBeTruthy();
    expect(await view.findByTestId('chat-home-screen')).toBeTruthy();
    expect(view.queryByTestId('home-screen')).toBeNull();
    // TWO sightings, one conversation: the panel row (the inventory and the
    // only selector) and the conversation's own head. It was three while the
    // working-set tab strip existed; revision 14 removed the strip, and this
    // count is how that stays removed.
    await waitFor(() =>
      expect(view.getAllByText('Plan the launch sequence')).toHaveLength(2),
    );
    fireEvent.click(view.getByRole('button', { name: /^New chat$/ }));
    expect(await view.findByText(/New conversation — pick a mode/)).toBeTruthy();
  });

  it('leads with a Home tab that reads CURRENT while you stand on the surface', async () => {
    const view = render(<GateApp />);
    await view.findByTestId('chat-home-screen');

    const tabs = view.getByRole('tablist', { name: 'Screens' });
    // Revision 16: the label is HOME. 15 called this tab Collab and named the
    // wrong one — the group id is still `chats`, which is what routes it.
    const chats = within(tabs).getByRole('tab', { name: 'Home' });
    // Revision 13's defect, pinned: no tab claimed this place, so standing
    // here nothing read as current and the only way back was an unlabelled
    // mark. The group is what makes the tab able to say "you are here".
    expect(chats.getAttribute('aria-selected')).toBe('true');
    // COLLAB is a DIFFERENT tab (group id `channels`) — the shared half. The
    // two are not interchangeable and standing here does not light it.
    expect(
      within(tabs).getByRole('tab', { name: 'Collab' }).getAttribute('aria-selected'),
    ).not.toBe('true');

    // It is a real door, not just a highlight: leave and come back by it.
    fireEvent.click(within(tabs).getByRole('tab', { name: 'Workspace' }));
    await waitFor(() => expect(view.queryByTestId('chat-home-screen')).toBeNull());
    fireEvent.click(within(tabs).getByRole('tab', { name: 'Home' }));
    expect(await view.findByTestId('chat-home-screen')).toBeTruthy();
  });

  it('keeps the brand mark as a second door that never competes for CURRENT', async () => {
    const view = render(<GateApp />);
    await view.findByTestId('chat-home-screen');
    const tabs = view.getByRole('tablist', { name: 'Screens' });

    // The mark was revision 13's only way back. 14 gave the tab back and kept
    // the mark, so the pair has to be non-contradictory: the mark navigates,
    // the TAB is what says where you are. A mark that also read current would
    // be two things claiming the same fact.
    const mark = view.getByTestId('go-home');
    expect(mark.getAttribute('role')).toBeNull();
    expect(mark.getAttribute('aria-selected')).toBeNull();

    fireEvent.click(within(tabs).getByRole('tab', { name: 'Workspace' }));
    await waitFor(() => expect(view.queryByTestId('chat-home-screen')).toBeNull());

    fireEvent.click(view.getByTestId('go-home'));
    expect(await view.findByTestId('chat-home-screen')).toBeTruthy();
    // Arriving by the mark lights the same tab as arriving by the tab.
    await waitFor(() =>
      expect(within(tabs).getByRole('tab', { name: 'Home' }).getAttribute('aria-selected'))
        .toBe('true'),
    );
  });

  it('is EXACTLY TWO PANES — no rail beside the list, no tab strip above the conversation', async () => {
    const view = render(<GateApp />);
    await view.findByTestId('chat-home-screen');
    await waitFor(() => expect(view.container.querySelector('.tch-thread__title')).toBeTruthy());

    // NO RAIL. The Chats group is railless, so the shell draws no third
    // column — the conversation LIST is the navigation and the screen owns it.
    expect(view.queryByTestId('menu-rail')).toBeNull();

    // NO WORKING-SET STRIP. The panel is the only conversation selector; the
    // one tablist on this screen is the shell's top row.
    expect(view.queryByRole('tablist', { name: 'Open conversations' })).toBeNull();
    expect(view.getAllByRole('tablist').map((n) => n.getAttribute('aria-label')))
      .toEqual(['Screens']);

    // And the two panes are both really there.
    expect(view.getByRole('complementary', { name: 'Conversations' })).toBeTruthy();
    expect(view.getByRole('region', { name: 'Conversation' })).toBeTruthy();
  });
});
