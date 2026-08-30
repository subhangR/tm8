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
    // Kinetic W4: the column BOOTS on Tasks now, so the thread list is one
    // root flip away — take it before counting sightings.
    /* THE CHATS-ROOT FLIP IS GONE WITH THE HEADER THAT HELD IT. The surface is
       solo on the dashboard, so it builds no `Home roots` tablist — the rail is
       the root switcher and the Chats root is where a bare /home already lands.
       There is nothing to flip TO, which is why this is a deletion rather than
       a re-targeting: re-pointing it at the rail would be testing the rail from
       a file about the chat screen. */
    /* ONE sighting, and it used to be two. The pair was the panel row plus the
       conversation's own head; the panel row is the thread column, and the
       dashboard mounts the surface SOLO, so the head is the only place a
       conversation names itself. The count is still the point — it was three
       while a working-set tab strip existed, and counting is how a duplicate
       naming stays gone — the number simply follows the surface. */
    await waitFor(() =>
      expect(view.getAllByText('Plan the launch sequence')).toHaveLength(1),
    );
    /* NEW CHAT MOVED OUT OF THE SCREEN AND ONTO HOME. Solo means the surface
       builds no root header, so its own ＋ is gone and Home's card is the one
       control for the verb — which is the "one control per verb" ruling
       arriving, not being broken. Matched on the label rather than the whole
       accessible name because the card names the verb and then explains it. */
    fireEvent.click(view.getByRole('button', { name: /New chat/ }));
    expect(await view.findByText(/New chat — pick a mode/)).toBeTruthy();
  });

  it('leads with a Home tab that reads CURRENT while you stand on the surface', async () => {
    const view = render(<GateApp />);
    await view.findByTestId('chat-home-screen');

    const tabs = view.getByRole('tablist', { name: 'Screens' });
    // Revision 17: the label is Home (rename only — the group id is still
    // `chats`, which is what routes it).
    const chats = within(tabs).getByRole('tab', { name: 'Home' });
    // Revision 13's defect, pinned: no tab claimed this place, so standing
    // here nothing read as current and the only way back was an unlabelled
    // mark. The group is what makes the tab able to say "you are here".
    expect(chats.getAttribute('aria-selected')).toBe('true');

    // It is a real door, not just a highlight: leave and come back by it.
    fireEvent.click(within(tabs).getByRole('tab', { name: 'Board' }));
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

    fireEvent.click(within(tabs).getByRole('tab', { name: 'Board' }));
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
    // Kinetic W4 boots the column on Tasks; the thread rows this case reads
    // live on the Chats root, one header-cell flip away.
    /* THE CHATS-ROOT FLIP IS GONE WITH THE HEADER THAT HELD IT. The surface is
       solo on the dashboard, so it builds no `Home roots` tablist — the rail is
       the root switcher and the Chats root is where a bare /home already lands.
       There is nothing to flip TO, which is why this is a deletion rather than
       a re-targeting: re-pointing it at the rail would be testing the rail from
       a file about the chat screen. */
    /* `.tch-thread__title` IS A THREAD-COLUMN ROW, and the dashboard has no
       thread column — the surface is solo. Waiting for the conversation's own
       head instead: same readiness signal, a surface that still exists. */
    await waitFor(() =>
      expect(view.container.querySelector('.tch-conversation__head')).toBeTruthy(),
    );

    // NO RAIL. The Chats group is railless, so the shell draws no third
    // column — the conversation LIST is the navigation and the screen owns it.
    expect(view.queryByTestId('menu-rail')).toBeNull();

    // NO WORKING-SET STRIP. The panel is the only conversation selector.
    // The tablists on this screen are the shell's top row and the left
    // column's OWN root header (task 01a00932 R5: [Chats +][Kind + ▾]) —
    // which lives in the panel and selects a POPULATION, not a conversation.
    expect(view.queryByRole('tablist', { name: 'Open conversations' })).toBeNull();
    /*
     * WAS `['Screens', 'Home roots']`, AND ONE PANE WENT RATHER THAN CAME.
     * This block's rule is "exactly two panes, no third" — it is a ceiling, so
     * dropping to one satisfies it more strictly, not less. The dashboard
     * mounts the chat SOLO now (2026-08-30): the surface owns no thread column,
     * so its own root header — the `Home roots` tablist, the [Chats +][Kind ▾]
     * switcher — is not built at all. The rail is the root switcher, and Home's
     * own New chat card is the create.
     *
     * Solo is DECLARED, not simulated with `display: none`. The stylesheet used
     * to hide this column, which left the screen believing it still owned one —
     * and that belief is what makes a null selection mean "the new-chat
     * composer". Hidden-but-believed shipped a dead New chat button.
     */
    expect(view.getAllByRole('tablist').map((n) => n.getAttribute('aria-label')))
      .toEqual(['Screens']);
    expect(
      view.queryByRole('complementary', { name: 'Tasks, chats and sessions' }),
      'the thread column is back — the screen is no longer solo and New chat will die again',
    ).toBeNull();
    expect(view.getByRole('region', { name: 'Conversation' })).toBeTruthy();
  });
});
