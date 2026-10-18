// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { Connections, EntityDetail, MessageView } from '@tm8/contract';
import { PhoneEntityPage, PhoneMessages, bodyTextOf, hasPhoneScreen, linkGroupsOf } from '.';

afterEach(cleanup);

const actor = { id: 'm1', kind: 'member', displayName: 'Subhang' };
const summary = (id: string, kind: string, title: string) =>
  ({
    id,
    kind,
    title,
    spaceId: 's',
    parentId: null,
    position: 0,
    visibility: 'space',
    version: 1,
    activityAt: '2026-10-18T00:00:00.000Z',
    createdAt: '2026-10-18T00:00:00.000Z',
    updatedAt: '2026-10-18T00:00:00.000Z',
    deletedAt: null,
    createdBy: actor,
    counters: {},
    state: { kind },
    badges: {},
  }) as never;

const message = (id: string, at: string, body: string): MessageView =>
  ({
    ...(summary(id, 'message', body) as object),
    createdAt: at,
    state: { kind: 'message', anchorId: 'x', rootMessageId: null, author: actor },
    content: { kind: 'message', body, mentions: [], attachments: [] },
    replyCount: 0,
  }) as never;

const connections: Connections = {
  outgoing: [
    {
      type: 'produces',
      direction: 'outgoing',
      label: 'Produces',
      edges: [{ id: 'e1', type: 'produces', source: summary('P', 'pull_request', 'PR'), target: summary('D', 'doc', 'Spec doc') } as never],
    },
  ],
  incoming: [
    {
      type: 'mentions',
      direction: 'incoming',
      label: 'Mentioned by',
      edges: [{ id: 'e2', type: 'mentions', source: summary('T', 'task', 'Fix nav'), target: summary('P', 'pull_request', 'PR') } as never],
    },
  ],
  unresolvedHardDependencyCount: 0,
};

const detail = {
  ...(summary('P', 'pull_request', 'Phone nav PR') as object),
  content: { kind: 'pull_request', description: 'Adds push/pop.' },
  connections,
} as unknown as EntityDetail;

describe('the generic entity page (CONTRACT §5 ruling 7)', () => {
  it('v1 phone screens are chat, doc, task, work_session and artifact; everything else is generic', () => {
    for (const k of ['chat', 'doc', 'task', 'work_session', 'artifact']) expect(hasPhoneScreen(k)).toBe(true);
    for (const k of ['pull_request', 'story', 'message', 'voice_channel', 'c:incident']) expect(hasPhoneScreen(k)).toBe(false);
  });

  it('reads the body from whatever the content calls it', () => {
    expect(bodyTextOf(detail)).toBe('Adds push/pop.');
  });

  it('groups Linked by edge label and points at the OTHER end of each edge', () => {
    const groups = linkGroupsOf(connections);
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ['Produces', ['D']],
      ['Mentioned by', ['T']],
    ]);
  });

  it('a Linked row pushes that entity’s page; messages sit under Linked', () => {
    const open = vi.fn();
    const view = render(
      <PhoneEntityPage detail={detail} messages={[message('m1', '2026-10-18T01:00:00Z', 'hello')]} onOpenEntity={open} />,
    );
    const rows = view.getAllByTestId('phone-linked-row');
    fireEvent.click(rows[1]!);
    expect(open).toHaveBeenCalledWith('T', 'task');
    const linked = view.getByTestId('phone-linked');
    const messages = view.getByTestId('phone-messages');
    expect(linked.compareDocumentPosition(messages) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('draws the page’s shape while the read is in flight, never a blank', () => {
    const view = render(<PhoneEntityPage detail={null} onOpenEntity={() => {}} />);
    expect(view.getByTestId('phone-entity-page').getAttribute('aria-busy')).toBe('true');
  });
});

describe('the Messages section (CONTRACT §5 ruling 8)', () => {
  const five = ['a', 'b', 'c', 'd', 'e'].map((b, i) => message(`m${i}`, `2026-10-18T0${i}:00:00Z`, b));

  it('shows the latest three in reading order, and View all opens the discussion', () => {
    const all = vi.fn();
    const view = render(<PhoneMessages messages={five} onViewAll={all} />);
    expect(view.getAllByTestId('phone-message').map((m) => m.textContent?.slice(-1))).toEqual(['c', 'd', 'e']);
    fireEvent.click(view.getByTestId('phone-messages-all'));
    expect(all).toHaveBeenCalledOnce();
    expect(view.getByTestId('phone-messages-all').textContent).toBe('View all 5');
  });

  it('says so when there are none, and while they load', () => {
    expect(render(<PhoneMessages messages={[]} onViewAll={() => {}} />).getByText('No messages yet.')).toBeTruthy();
    cleanup();
    expect(render(<PhoneMessages messages={undefined} />).getByText('Loading messages…')).toBeTruthy();
  });
});
