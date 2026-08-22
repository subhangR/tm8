// @vitest-environment jsdom
/**
 * THE PHONE'S HOSTED CHAT COLUMN DOES NOT OUTLIVE ITS PROJECT — cause 3 of
 * "when project is switched chat list doesn't get updated" (reported by
 * Subhang).
 *
 * WHY THE HOOK AND NOT THE SHELL. `MobileShell` needs a whole `Seam` to
 * render — the chat screen it hosts builds a real port from one — so standing
 * the shell up here would be building a fake node to observe four lines of
 * state. `useSpaceScopedChat` IS those four lines, it is the shell's only
 * holder of them, and the shell cannot keep them anywhere else without
 * deleting the call. What is asserted is therefore the real code under real
 * React semantics, not a source pattern that happens to be present.
 *
 * The order these run in matters and is asserted: the reset must have happened
 * BY THE TIME the new project's render is readable, because the thing being
 * prevented is a frame that draws the old project's rows.
 */
import { act, render } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { describe, expect, it } from 'vitest';
import type { EntityId, SpaceId } from '@tm8/contract';
import { useSpaceScopedChat } from './MobileShell';
import type { ChatThreadSummary } from '../chat-home/types';

const SPACE_A = '019f0000-0000-7000-8000-0000000000a0' as SpaceId;
const SPACE_B = '019f0000-0000-7000-8000-0000000000b0' as SpaceId;
const A_ROOT = '019f0000-0000-7000-8000-0000000000a1' as EntityId;

const A_THREADS = [
  {
    rootId: A_ROOT,
    anchorId: A_ROOT,
    title: 'Alpha migration',
    preview: 'Alpha migration',
    updatedAt: '2026-08-21T09:00:00.000Z',
    replyCount: 1,
    config: {
      teammateId: '019f0000-0000-7000-8000-000000000002' as EntityId,
      teammateLabel: 'Forge',
      model: 'claude-sonnet-4-5',
      modelLabel: 'Sonnet 4.5',
      mode: 'ask',
    },
    state: 'idle',
  },
] as const satisfies readonly ChatThreadSummary[];

/** Every COMMIT the hook's owner made, in order — `titles` is what the drawer
 *  would have drawn on that pass and `threadId` is what would have been pushed
 *  down as `routeThreadId`.
 *
 *  RECORDED IN A LAYOUT EFFECT, and the distinction is the whole test. A
 *  render-phase set makes React re-run the component and THROW THE FIRST PASS
 *  AWAY — it is never committed, never painted, and no child ever sees it — so
 *  a probe that recorded during render would report a leak that does not exist
 *  and would report it identically for the correct fix and the broken one.
 *  Layout effects run only for renders that were kept, which is the same set
 *  of frames the viewer could have seen. */
interface Frame {
  space: string;
  titles: string[];
  threadId: string | null;
}

function harness() {
  const frames: Frame[] = [];
  let api: ReturnType<typeof useSpaceScopedChat> | null = null;

  function Probe({ spaceId }: { spaceId: SpaceId }) {
    const chat = useSpaceScopedChat(spaceId);
    api = chat;
    useLayoutEffect(() => {
      frames.push({
        space: spaceId,
        titles: chat.threads.map((thread) => thread.title),
        threadId: chat.threadId,
      });
    });
    return null;
  }

  const view = render(<Probe spaceId={SPACE_A} />);
  return {
    frames,
    /** The chat screen publishing its list and selection back up, which is the
     *  only way this state is ever filled. */
    publish(threads: readonly ChatThreadSummary[], threadId: EntityId | null) {
      act(() => {
        api!.setThreads(threads);
        api!.setThreadId(threadId);
      });
    },
    switchTo(spaceId: SpaceId) {
      view.rerender(<Probe spaceId={spaceId} />);
    },
    current: () => frames[frames.length - 1]!,
  };
}

describe('the phone shell forgets a project’s conversations when it leaves it', () => {
  /**
   * HINGES ON: the `chatSpaceId !== spaceId` block in `useSpaceScopedChat`.
   * Remove it and both assertions red — the drawer keeps the old project's
   * rows and `routeThreadId` keeps naming a root the new project has never
   * heard of.
   */
  it('drops the list and the selection when the project changes', () => {
    const shell = harness();
    shell.publish(A_THREADS, A_ROOT);
    expect(shell.current().titles).toEqual(['Alpha migration']);

    shell.switchTo(SPACE_B);
    expect(shell.current().titles).toEqual([]);
    expect(shell.current().threadId).toBeNull();
  });

  /**
   * THE PART AN EFFECT WOULD NOT GIVE, and the reason the reset is written
   * during render. A `useEffect` reset commits one frame FIRST with the old
   * project's rows still in state — on a phone that is a visible flash of
   * somebody else's conversations under the new project's header, and if the
   * screen reads `routeThreadId` in that window it tries to open an entity id
   * that does not exist in the space it is now in.
   *
   * So: not one single render of space B may carry space A's rows. Asserted
   * over EVERY frame rather than the last one, because "it settles correctly"
   * is precisely the weaker claim that an effect would also satisfy.
   */
  it('never renders the new project holding the old project’s rows', () => {
    const shell = harness();
    shell.publish(A_THREADS, A_ROOT);
    shell.switchTo(SPACE_B);

    const leaked = shell.frames.filter(
      (frame) => frame.space === SPACE_B && (frame.titles.length > 0 || frame.threadId !== null),
    );
    expect(leaked).toEqual([]);
    // And the switch really did happen — an assertion that never sees space B
    // would pass this vacuously.
    expect(shell.frames.some((frame) => frame.space === SPACE_B)).toBe(true);
  });

  /** Switching AWAY and BACK is a switch like any other: the rows must be
   *  re-read, never restored from what this shell happened to remember. A
   *  cache keyed by space would pass the two tests above and fail this one. */
  it('does not restore the old rows when the viewer returns', () => {
    const shell = harness();
    shell.publish(A_THREADS, A_ROOT);
    shell.switchTo(SPACE_B);
    shell.switchTo(SPACE_A);

    expect(shell.current().titles).toEqual([]);
    expect(shell.current().threadId).toBeNull();
  });
});
