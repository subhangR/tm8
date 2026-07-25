/**
 * Inbox — notification rows with read state, click marks read + opens the
 * target panel, and mark-all-read clears the unread count.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { InboxScreen, inboxViews, specForNotification } from '../../screens/inbox';
import { createFacade, renderWith, resetStores, viewProps } from './helpers';

describe('InboxScreen', () => {
  beforeEach(() => { resetStores(); });

  it('registers itself as the `inbox` view', () => {
    expect(inboxViews.inbox).toBe(InboxScreen);
  });

  it('renders seeded notifications with a data-driven kind pill', async () => {
    const facade = createFacade();
    const inbox = await facade.getInbox();
    renderWith(facade, <InboxScreen {...viewProps(facade, { view: 'inbox' })} />);

    const first = inbox.items[0];
    const row = await screen.findByTestId(`notif-${first.id}`);
    expect(row).toHaveAttribute('data-read', 'false');
    expect(within(row).getByText(specForNotification(first.kind).label)).toBeInTheDocument();

    // Every seeded kind resolves through the table, never a conditional.
    for (const kind of new Set(inbox.items.map((n) => n.kind))) {
      expect(specForNotification(kind).label.length).toBeGreaterThan(0);
    }
  });

  it('marking read on click flips row state and opens the target panel', async () => {
    const facade = createFacade();
    const markRead = vi.spyOn(facade, 'markNotificationRead');
    const onOpenEntity = vi.fn();
    const inbox = await facade.getInbox();
    const target = inbox.items.find((n) => n.target != null);
    if (!target?.target) throw new Error('seed has no notification with a target');

    renderWith(facade, <InboxScreen {...viewProps(facade, { view: 'inbox', onOpenEntity })} />);

    const row = await screen.findByTestId(`notif-${target.id}`);
    expect(row).toHaveAttribute('data-read', 'false');
    fireEvent.click(screen.getByTestId(`notif-main-${target.id}`));

    await waitFor(() => expect(markRead).toHaveBeenCalledWith(target.id));
    expect(onOpenEntity).toHaveBeenCalledWith(target.target.id);
    await waitFor(() => {
      expect(screen.getByTestId(`notif-${target.id}`)).toHaveAttribute('data-read', 'true');
    });
  });

  it('mark all read empties the unread count', async () => {
    const facade = createFacade();
    renderWith(facade, <InboxScreen {...viewProps(facade, { view: 'inbox' })} />);

    const counter = await screen.findByTestId('inbox-unread');
    await waitFor(() => expect(counter.textContent).not.toBe('0 unread'));

    fireEvent.click(screen.getByTestId('mark-all-read'));
    await waitFor(() => expect(screen.getByTestId('inbox-unread')).toHaveTextContent('0 unread'));
  });

  it('unread-only filter hides read rows', async () => {
    const facade = createFacade();
    const inbox = await facade.getInbox();
    const first = inbox.items[0];
    renderWith(facade, <InboxScreen {...viewProps(facade, { view: 'inbox' })} />);

    await screen.findByTestId(`notif-${first.id}`);
    fireEvent.click(screen.getByTestId(`notif-main-${first.id}`));
    await waitFor(() => {
      expect(screen.getByTestId(`notif-${first.id}`)).toHaveAttribute('data-read', 'true');
    });

    fireEvent.click(screen.getByRole('button', { name: 'unread only' }));
    await waitFor(() => expect(screen.queryByTestId(`notif-${first.id}`)).toBeNull());
  });
});
