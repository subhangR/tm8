// @vitest-environment jsdom
/**
 * SWITCHING PROJECT MUST CHANGE THE CHAT LIST — the three causes, one guard
 * each. Reported by Subhang: "when project is switched chat list doesn't get
 * updated".
 *
 * Each test below was written against the broken tree first and seen to fail;
 * the note on each says which line it hinges on, so the next person can break
 * it again in one edit rather than trusting a green run.
 *
 * THE PORT HERE IS SPACE-AWARE ON PURPOSE. `createChatHomeFixturePort` ignores
 * the `spaceId` argument entirely — every space gets the same rows — so it
 * cannot see this class of bug at all: a screen reading the WRONG project's
 * list still gets the right answer from it. This port answers per space and
 * records every id it was asked for, which is what makes "it read a project
 * the viewer had left" an assertable fact rather than an inference from what
 * ended up on screen.
 */
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ActorSummary, EntityId, SpaceId } from '@tm8/contract';
import { ChatHomeScreen } from './ChatHomeScreen';
import type {
  ChatHomePort,
  ChatModelOption,
  ChatThreadDetail,
  ChatThreadSummary,
  ChatTurnFrame,
} from './types';

const SPACE_A = '019f0000-0000-7000-8000-0000000000a0' as SpaceId;
const SPACE_B = '019f0000-0000-7000-8000-0000000000b0' as SpaceId;

const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
];

const AGENT: ActorSummary = {
  id: '019f0000-0000-7000-8000-000000000002',
  kind: 'team_member',
  displayName: 'Forge',
  avatar: null,
  isAgent: true,
};

function summary(rootId: string, title: string): ChatThreadSummary {
  return {
    rootId: rootId as EntityId,
    anchorId: rootId as EntityId,
    title,
    preview: title,
    updatedAt: '2026-08-21T09:00:00.000Z',
    replyCount: 1,
    config: {
      teammateId: AGENT.id as EntityId,
      teammateLabel: 'Forge',
      model: 'claude-sonnet-4-5',
      modelLabel: 'Sonnet 4.5',
      mode: 'ask',
    },
    state: 'idle',
  };
}

/** Space A's rows and space B's rows share no root id — entity ids are
 *  space-scoped, which is the whole reason a leaked list is a bug and not
 *  merely stale. */
const A_THREADS = [summary('019f0000-0000-7000-8000-0000000000a1', 'Alpha migration')];
const B_THREADS = [summary('019f0000-0000-7000-8000-0000000000b1', 'Beta rollout')];

interface Recorder {
  readonly port: ChatHomePort;
  /** Every space id `listThreads` was called with, in order. */
  readonly reads: string[];
  /** Reads resolve as they are made until `hold()`; after it they stay open
   *  until released BY SPACE, so a test can decide which of two overlapping
   *  reads lands last. Landing order is the whole subject here — a stale read
   *  that lands first is harmless, and one that lands last is the bug. */
  hold(): void;
  release(spaceId: string): Promise<void>;
  /** Make the NEXT read of this space reject once — a node that is briefly
   *  unreachable, which the screen already has a `loadError` branch for. */
  failNext(spaceId: string): void;
  emit(frame: ChatTurnFrame): void;
}

function createSpaceAwarePort(): Recorder {
  const rows = new Map<string, readonly ChatThreadSummary[]>([
    [SPACE_A, A_THREADS],
    [SPACE_B, B_THREADS],
  ]);
  const reads: string[] = [];
  const listeners = new Set<(frame: ChatTurnFrame) => void>();
  let holding = false;
  let pending: Array<{ space: string; resolve: () => void }> = [];
  const failing = new Set<string>();

  const port: ChatHomePort = {
    async listThreads(spaceId) {
      reads.push(String(spaceId));
      if (failing.delete(String(spaceId))) {
        throw new Error(`This node cannot read ${String(spaceId)} right now.`);
      }
      if (holding) {
        await new Promise<void>((resolve) => pending.push({ space: String(spaceId), resolve }));
      }
      return rows.get(String(spaceId)) ?? [];
    },
    async readThread(rootId) {
      const found = [...rows.values()].flat().find((thread) => thread.rootId === rootId);
      if (!found) throw new Error(`No thread ${rootId} in this space.`);
      const detail: ChatThreadDetail = { summary: found, turns: [] };
      return detail;
    },
    async listTeammates() {
      return [{ id: AGENT.id as EntityId, label: 'Forge', avatar: null }];
    },
    startThread: {
      unavailableReason: null,
      async createRoot() {
        throw new Error('not used');
      },
      async configure() {
        throw new Error('not used');
      },
    },
    async postTurn() {
      throw new Error('not used');
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return {
    port,
    reads,
    hold() {
      holding = true;
    },
    async release(spaceId) {
      const waiting = pending.filter((entry) => entry.space === spaceId);
      pending = pending.filter((entry) => entry.space !== spaceId);
      for (const entry of waiting) entry.resolve();
      // One macrotask is enough for the awaits chained onto them.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
    failNext(spaceId) {
      failing.add(spaceId);
    },
    emit(frame) {
      for (const listener of [...listeners]) listener(frame);
    },
  };
}

/** The conversation ROWS, by title. Asserted on rather than on the document
 *  text, because the open conversation's title is also drawn by the centre —
 *  "is it in the list" and "is it on screen somewhere" are different
 *  questions and only the first one is this list's job. */
function rowTitles(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.tch-thread__title')].map((node) =>
    (node.textContent ?? '').trim(),
  );
}

function deltaFor(rootId: string): ChatTurnFrame {
  return {
    type: 'chat.turn.delta',
    threadRootId: rootId as EntityId,
    messageId: '019f0000-0000-7000-8000-0000000000f1' as EntityId,
    seq: 0,
    part: { kind: 'text', text: 'working' },
  } as ChatTurnFrame;
}

describe('switching project switches the conversation list', () => {
  /**
   * THE BASELINE, and honestly labelled as one: it PASSES on the broken tree.
   * The opening read is keyed on `spaceId` and has always re-run, so a switch
   * with no frame arriving in the window looks fine — which is exactly why the
   * report reads as intermittent. What it guards is the floor: if this ever
   * reds, the switch has stopped re-reading at all and the three tests below
   * are guarding a screen that was already broken before their first frame.
   *
   * HINGES ON: the `spaceId` dep of the opening read, and the space-change
   * reset that empties the list rather than leaving the old rows to be
   * replaced — the previous project's rows must be GONE, not outnumbered.
   */
  it('draws the new project rows and none of the old ones', async () => {
    const fixture = createSpaceAwarePort();
    const view = render(<ChatHomeScreen port={fixture.port} spaceId={SPACE_A} models={MODELS} />);
    await waitFor(() => expect(rowTitles(view.container)).toEqual(['Alpha migration']));

    view.rerender(<ChatHomeScreen port={fixture.port} spaceId={SPACE_B} models={MODELS} />);
    await waitFor(() => expect(rowTitles(view.container)).toEqual(['Beta rollout']));
  });

  /**
   * CAUSE 1, and the reason the report says the list "doesn't get updated"
   * rather than "is slow". HINGES ON: `refreshThreads` being listed in the
   * `port.subscribe` effect's deps. Drop it and the subscription is created
   * once for the app's lifetime — `port`, the bridge and the seam are all
   * memoized above any space change — so its handler keeps calling
   * `listThreads` for the project the viewer LEFT.
   *
   * Asserted on the READ and not on the DOM: a handler that asks for space A
   * is the defect, whatever the answer happens to look like by the time it
   * lands.
   */
  it('never re-reads the project the viewer has left', async () => {
    const fixture = createSpaceAwarePort();
    const view = render(<ChatHomeScreen port={fixture.port} spaceId={SPACE_A} models={MODELS} />);
    await waitFor(() => expect(rowTitles(view.container)).toEqual(['Alpha migration']));

    view.rerender(<ChatHomeScreen port={fixture.port} spaceId={SPACE_B} models={MODELS} />);
    await waitFor(() => expect(rowTitles(view.container)).toEqual(['Beta rollout']));

    const afterSwitch = fixture.reads.length;
    // A frame for a root neither project's list knows: the handler's "this is
    // new, re-read the list" path, which is the path that closed over the old
    // space id.
    await act(async () => {
      fixture.emit(deltaFor('019f0000-0000-7000-8000-0000000000c9'));
      await Promise.resolve();
    });

    await waitFor(() => expect(fixture.reads.length).toBeGreaterThan(afterSwitch));
    expect(fixture.reads.slice(afterSwitch)).not.toContain(String(SPACE_A));
    expect(rowTitles(view.container)).toEqual(['Beta rollout']);
  });

  /**
   * THE OTHER HALF OF CAUSE 1: a read that was already in flight when the
   * switch happened. Correct deps stop a stale read being STARTED; they cannot
   * stop a started one LANDING, and landing is what overwrites the list.
   * HINGES ON: the `spaceRef.current !== spaceId` guard in `refreshThreads`.
   */
  it('drops a list read that was in flight when the project changed', async () => {
    const fixture = createSpaceAwarePort();
    const view = render(<ChatHomeScreen port={fixture.port} spaceId={SPACE_A} models={MODELS} />);
    await waitFor(() => expect(rowTitles(view.container)).toEqual(['Alpha migration']));

    // A frame for an unknown root starts a refresh, and we hold its answer.
    fixture.hold();
    await act(async () => {
      fixture.emit(deltaFor('019f0000-0000-7000-8000-0000000000c9'));
      await Promise.resolve();
    });

    view.rerender(<ChatHomeScreen port={fixture.port} spaceId={SPACE_B} models={MODELS} />);
    // The new project's list arrives first and the screen is correct...
    await act(async () => {
      await fixture.release(String(SPACE_B));
    });
    await waitFor(() => expect(rowTitles(view.container)).toEqual(['Beta rollout']));

    // ...and THEN the read the viewer left behind finishes. This ordering is
    // the one that matters: a stale read that lands first is overwritten by
    // the real one and nobody notices; a stale read that lands LAST is the
    // report. Nothing about a network makes the harmless order the likely one.
    await act(async () => {
      await fixture.release(String(SPACE_A));
    });
    expect(rowTitles(view.container)).toEqual(['Beta rollout']);
  });

  /**
   * CAUSE 2, first half. HINGES ON: the seeding line in the opening read —
   * `knownRootsRef` and the list must agree about what the sidebar holds, and
   * the opening read is what repopulates both after a switch.
   *
   * Read as a pair: a root the NEW project's list already contains must not
   * provoke a re-read, and one it does not contain must — for the project now
   * on screen, never for the one it names.
   */
  it('re-answers "is this root new?" for the project now on screen', async () => {
    const fixture = createSpaceAwarePort();
    const view = render(<ChatHomeScreen port={fixture.port} spaceId={SPACE_A} models={MODELS} />);
    await waitFor(() => expect(rowTitles(view.container)).toEqual(['Alpha migration']));

    view.rerender(<ChatHomeScreen port={fixture.port} spaceId={SPACE_B} models={MODELS} />);
    await waitFor(() => expect(rowTitles(view.container)).toEqual(['Beta rollout']));

    const settled = fixture.reads.length;
    await act(async () => {
      fixture.emit(deltaFor(B_THREADS[0]!.rootId));
      await Promise.resolve();
    });
    expect(fixture.reads.length).toBe(settled);

    // Space A's root is NOT known here — this project has never seen it — so
    // it is treated as new and the list is re-read, for space B.
    await act(async () => {
      fixture.emit(deltaFor(A_THREADS[0]!.rootId));
      await Promise.resolve();
    });
    await waitFor(() => expect(fixture.reads.length).toBeGreaterThan(settled));
    expect(fixture.reads.slice(settled)).toEqual([String(SPACE_B)]);
  });

  /**
   * CAUSE 2, second half, and the one that shows why clearing the ref is not
   * merely tidy. HINGES ON: `knownRootsRef.current = new Set()` in the
   * space-change effect.
   *
   * When the opening read for the new project FAILS there is nothing to seed
   * the ref from, so whatever the switch left in it is what the frame handler
   * keeps answering with. Uncleared, it holds the OLD project's roots, and the
   * one path back to a correct list — "a frame names a root I do not know, so
   * re-read" — is answered "I know that root" by a project the viewer has
   * left. The screen then stays wrong until a reload. Cleared, the next frame
   * is the recovery.
   */
  it('recovers the list when the opening read for the new project failed', async () => {
    const fixture = createSpaceAwarePort();
    const view = render(<ChatHomeScreen port={fixture.port} spaceId={SPACE_A} models={MODELS} />);
    await waitFor(() => expect(rowTitles(view.container)).toEqual(['Alpha migration']));

    fixture.failNext(String(SPACE_B));
    view.rerender(<ChatHomeScreen port={fixture.port} spaceId={SPACE_B} models={MODELS} />);
    await waitFor(() => expect(rowTitles(view.container)).toEqual([]));

    // A frame for one of the OLD project's roots. It is not a root of the
    // project on screen, so it is new here and the list is re-read.
    await act(async () => {
      fixture.emit(deltaFor(A_THREADS[0]!.rootId));
      await Promise.resolve();
    });
    await waitFor(() => expect(rowTitles(view.container)).toEqual(['Beta rollout']));
  });
});
