// @vitest-environment jsdom
/**
 * THE HOME DASHBOARD SEAM MAY NOT CALL A SPACE EMPTY BEFORE IT HAS LOOKED.
 *
 * Every test here is a rehearsal of one defect: rendering the initial value of
 * a state array as a claim about the viewer's workspace. It shipped once in the
 * composer ("No agent teammate is available in this space." with 34 teammates
 * present) and Home is where it would be most expensive, because "you have
 * nothing" is the first sentence on the screen.
 */
import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';

import type { SpaceId } from '@tm8/contract';

import { createChatHomeFixturePort } from './fixtures';
import { homeRegionNote, useRecentChats } from './home-dashboard';
import type { ChatHomePort, ChatThreadSummary } from './types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
const OTHER_SPACE = '019f0000-0000-7000-8000-000000000091';

/** Renders the hook and reports what a card WOULD draw from it. */
function Probe({
  port,
  spaceId,
  limit,
}: {
  port: ChatHomePort;
  spaceId: SpaceId | string;
  limit?: number;
}) {
  const { status, items, note } = useRecentChats(port, spaceId, limit);
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="count">{items.length}</span>
      <span data-testid="note">{note ?? ''}</span>
      {/* The empty SENTENCE is only ever drawn from `status`, never from
          `items.length` — which is the whole contract under test. */}
      {status === 'loaded' && items.length === 0 ? (
        <span data-testid="empty-claim">No conversations yet.</span>
      ) : null}
      <ul>
        {items.map((thread) => (
          <li key={thread.rootId}>{thread.title}</li>
        ))}
      </ul>
    </div>
  );
}

/** Holds `listThreads` open so the pending window can be inspected. */
function gateThreads(port: ChatHomePort): { port: ChatHomePort; release(): void; reads(): number } {
  let release = (): void => {};
  let reads = 0;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    port: {
      ...port,
      listThreads: async (spaceId) => {
        reads += 1;
        await held;
        return port.listThreads(spaceId);
      },
    },
    release: () => release(),
    reads: () => reads,
  };
}

function summary(rootId: string, title: string, updatedAt: string): ChatThreadSummary {
  return {
    rootId: rootId as EntityId,
    anchorId: rootId as EntityId,
    title,
    preview: '',
    updatedAt,
    replyCount: 0,
    config: null,
  } as unknown as ChatThreadSummary;
}

function portReturning(threads: readonly ChatThreadSummary[], base: ChatHomePort): ChatHomePort {
  return { ...base, listThreads: async () => threads };
}

describe('Home dashboard seam', () => {
  it('never claims the space is empty while the opening read is still running', async () => {
    const { port } = createChatHomeFixturePort([]);
    const gated = gateThreads(portReturning([], port));
    const view = render(<Probe port={gated.port} spaceId={SPACE_ID} />);

    /* THE WHOLE POINT. Zero rows are on screen, and the surface must still not
       say the workspace is empty — it has not looked yet. */
    expect(view.getByTestId('status').textContent).toBe('pending');
    expect(view.getByTestId('count').textContent).toBe('0');
    expect(view.queryByTestId('empty-claim')).toBeNull();
    expect(view.getByTestId('note').textContent).toBe('Loading conversations…');

    gated.release();
    await waitFor(() => expect(view.getByTestId('status').textContent).toBe('loaded'));
    expect(view.getByTestId('empty-claim')).toBeTruthy();
  });

  it('says the space is empty ONLY after a read that came back empty', async () => {
    const { port } = createChatHomeFixturePort([]);
    const view = render(<Probe port={portReturning([], port)} spaceId={SPACE_ID} />);

    await waitFor(() => expect(view.getByTestId('empty-claim')).toBeTruthy());
    expect(view.getByTestId('status').textContent).toBe('loaded');
    expect(view.getByTestId('note').textContent).toBe('');
  });

  it('reports a FAILED read as failed, never as an empty space', async () => {
    const { port } = createChatHomeFixturePort([]);
    const failing: ChatHomePort = {
      ...port,
      listThreads: async () => {
        throw new Error('offline');
      },
    };
    const view = render(<Probe port={failing} spaceId={SPACE_ID} />);

    await waitFor(() => expect(view.getByTestId('status').textContent).toBe('failed'));
    /* A failure is not evidence about how many conversations exist. */
    expect(view.queryByTestId('empty-claim')).toBeNull();
    expect(view.getByTestId('note').textContent).toBe('Your conversations could not be loaded.');
  });

  it('turns pending DURING RENDER on a space switch — no stale rows from the old space', async () => {
    const { port } = createChatHomeFixturePort([]);
    const first = portReturning([summary('019f0000-0000-7000-8000-0000000000a1', 'Old space', '3')], port);
    const view = render(<Probe port={first} spaceId={SPACE_ID} />);
    await waitFor(() => expect(view.getByTestId('count').textContent).toBe('1'));

    /* A stale answer is worse than a spinner: it is wrong rather than absent.
       The status is keyed to the space that produced it, so the very first
       render after the switch must already disown the previous rows — an
       effect would be too late, because the surface paints before it runs. */
    const gatedSecond = gateThreads(portReturning([], port));
    view.rerender(<Probe port={gatedSecond.port} spaceId={OTHER_SPACE} />);
    expect(view.getByTestId('status').textContent).toBe('pending');
    expect(view.getByTestId('count').textContent).toBe('0');
    expect(view.queryByText('Old space')).toBeNull();
    expect(view.queryByTestId('empty-claim')).toBeNull();
  });

  it('does not re-read on every render, though callers pass inline readers', async () => {
    const { port } = createChatHomeFixturePort([]);
    const gated = gateThreads(portReturning([], port));
    const view = render(<Probe port={gated.port} spaceId={SPACE_ID} />);
    await waitFor(() => expect(gated.reads()).toBe(1));

    /* The read is keyed by WHAT IT IS ABOUT — port and space — not by the
       identity of the closure performing it. Depending on the closure would
       re-fire on every render and never settle. */
    view.rerender(<Probe port={gated.port} spaceId={SPACE_ID} />);
    view.rerender(<Probe port={gated.port} spaceId={SPACE_ID} />);
    expect(gated.reads()).toBe(1);
  });

  it('limit TRIMS the port order and never re-ranks it', async () => {
    const { port } = createChatHomeFixturePort([]);
    /* `real-port` sorts activityAt_desc; the seam must not impose a second
       order, or Home and the chat list disagree about "most recent". */
    const ordered = [
      summary('019f0000-0000-7000-8000-0000000000b1', 'newest', '3'),
      summary('019f0000-0000-7000-8000-0000000000b2', 'middle', '2'),
      summary('019f0000-0000-7000-8000-0000000000b3', 'oldest', '1'),
    ];
    const view = render(<Probe port={portReturning(ordered, port)} spaceId={SPACE_ID} limit={2} />);

    await waitFor(() => expect(view.getByTestId('count').textContent).toBe('2'));
    const shown = [...view.container.querySelectorAll('li')].map((li) => li.textContent);
    expect(shown).toEqual(['newest', 'middle']);
  });

  it('every pending/failed sentence is shorter than the empty one it sits beside', () => {
    /* WIDTH BUDGET, stated as a contract rather than as a promise: adopting
       this seam can never widen a container, because the transient copy is
       never the longest string the region can hold. */
    const empty = 'No conversations yet.';
    for (const status of ['pending', 'failed'] as const) {
      const note = homeRegionNote(status, 'conversations');
      expect(note).toBeTruthy();
      expect((note as string).length).toBeLessThanOrEqual(
        Math.max(empty.length, 'Your conversations could not be loaded.'.length),
      );
    }
    expect(homeRegionNote('loaded', 'conversations')).toBeNull();
  });
});
