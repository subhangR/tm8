// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { EntityFeedPage, PostMessageInput } from '@tm8/contract';
import { createFixtureSeam } from '../data';
import { taskGuideLines } from '../fixtures';
import { ChannelScreen } from './ChannelScreen';

/**
 * THE TEST THAT LIVES IN THE GAP (§4.3 of the worker brief, D57's amended rule).
 *
 * The rowsFor incident: four links — declaration, data, implementation, CALL —
 * each verified green while the feature was dead, because nobody asserted that
 * the caller passes the argument. Four sessions rendered as twelve, through
 * four green suites.
 *
 * So this file deliberately owns NEITHER side. `ChannelScreen.test.tsx` proves
 * the component calls its `onPost` prop with a particular object; the fixture
 * seam's own suite proves `commands.postMessage` stores a message. Both can be
 * green while the shape the component emits is one the seam rejects — which is
 * exactly the class of defect that reaches a real screen as "I press Send and
 * nothing happens".
 *
 * This drives the REAL composer into the REAL seam and then READS THE MESSAGE
 * BACK through the real feed read. Nothing is stubbed except `clientMutationId`
 * (the caller's to supply, per the seam docblock) and the anchor id.
 *
 * WHAT IT DOES NOT PROVE, said plainly: the fixture seam is not the real seam.
 * A `createRealSeam()` twin of this test would need a live node and is out of
 * this lane's reach; the shape assertion below is contract-typed, so a divergence
 * between the two implementations would be a contract violation, not a silent
 * pass. NOT CHECKED against a live node.
 */

const EMPTY: EntityFeedPage = {
  resolvedScope: 'direct_v1',
  predicates: ['anchored'],
  items: [],
  nextCursor: null,
};

describe('composer → seam.commands.postMessage → seam.feed, end to end', () => {
  it('emits a payload the REAL fixture seam accepts, and the message comes back on the feed', async () => {
    const seam = createFixtureSeam();
    const sent: PostMessageInput[] = [];

    render(
      <ChannelScreen
        anchorId={taskGuideLines.id}
        anchorNoun="this channel"
        page={EMPTY}
        onPost={async (input) => {
          // THE CROSSING. The component supplies anchorIds/body/parentMessageId;
          // the host supplies clientMutationId, exactly as the seam docblock
          // specifies ("the caller supplies clientMutationId so stores can
          // journal before the promise settles"). If the component's object
          // shape drifts, this call stops type-checking or the seam rejects it.
          const payload: PostMessageInput = { ...input, clientMutationId: 'gap-test-1' };
          sent.push(payload);
          await seam.commands.postMessage(payload);
        }}
      />,
    );

    fireEvent.change(screen.getByRole('textbox', { name: /message/i }), {
      target: { value: 'Kick off the tree-rule port next.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    // The call actually happened, with the anchor the surface was mounted on.
    await vi_waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].anchorIds).toEqual([taskGuideLines.id]);
    expect(sent[0].body).toBe('Kick off the tree-rule port next.');

    // …and the write is REACHABLE on the read side. This is the assertion the
    // rowsFor defect would have failed: not "the executor implements it" but
    // "the caller's argument arrived".
    const feed = await seam.feed(taskGuideLines.id);
    const bodies = feed.items
      .filter((i) => i.itemKind === 'message')
      .map((i) => (i.itemKind === 'message' ? i.message.content.body : ''));
    expect(bodies).toContain('Kick off the tree-rule port next.');

    seam.dispose();
  });

  it('threads a reply’s parentMessageId across the same crossing', async () => {
    // parentMessageId is the field most likely to be dropped silently: the post
    // succeeds either way, and the only visible difference is a reply that
    // renders as a top-level message. Nothing else in the suite would catch it.
    const seam = createFixtureSeam();
    const first = await seam.messages(taskGuideLines.id);
    const parent = first.items[0];
    expect(parent, 'the fixture anchor must carry at least one message to reply to').toBeTruthy();

    const sent: PostMessageInput[] = [];
    render(
      <ChannelScreen
        anchorId={taskGuideLines.id}
        anchorNoun="this channel"
        page={{
          ...EMPTY,
          items: [{
            itemId: `feed-${parent.id}`,
            createdAt: parent.createdAt,
            sortId: `${parent.createdAt}#${parent.id}`,
            via: ['anchored'],
            actor: parent.state.author,
            sourceWorkSessionId: null,
            anchor: null,
            logicalOperationId: null,
            itemKind: 'message',
            message: parent,
            delivery: [],
          }],
        }}
        onPost={async (input) => {
          const payload: PostMessageInput = { ...input, clientMutationId: 'gap-test-2' };
          sent.push(payload);
          await seam.commands.postMessage(payload);
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: /^reply to /i })[0]);
    fireEvent.change(screen.getByRole('textbox', { name: /message/i }), {
      target: { value: 'on it' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    await vi_waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].parentMessageId).toBe(parent.id);

    seam.dispose();
  });
});

/** Minimal poll — @testing-library's waitFor pulls in timers this file doesn't need. */
async function vi_waitFor(assert: () => void, tries = 20): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      assert();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  assert();
}
