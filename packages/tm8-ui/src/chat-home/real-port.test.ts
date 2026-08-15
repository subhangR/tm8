import { describe, expect, it, vi } from 'vitest';
import type { EntityId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { createChatHomePortFromSeam } from './real-port';

const ROOT = '019f0000-0000-7000-8000-000000000201' as EntityId;
const ANCHOR = '019f0000-0000-7000-8000-000000000202' as EntityId;
const TEAMMATE = '019f0000-0000-7000-8000-000000000203' as EntityId;

function seamStub() {
  const postMessage = vi.fn(async () => ({
    entity: { id: ROOT, kind: 'message' },
    patches: [],
  }));
  const seam = {
    query: vi.fn(async () => ({
      page: { items: [{ id: TEAMMATE, title: 'Forge' }] },
    })),
    commands: { postMessage },
    onChatTurn: vi.fn(() => () => undefined),
  } as unknown as Seam;
  return { seam, postMessage };
}

describe('real chat-home seam adapter', () => {
  it('keeps the missing L2 reads and config op visibly unavailable', async () => {
    const { seam } = seamStub();
    const port = createChatHomePortFromSeam(seam);
    expect(port.threadListUnavailableReason).toMatch(/chatThreads read/);
    expect(port.startThread.unavailableReason).toMatch(/configuration operation/);
    expect(await port.listThreads('space-1')).toEqual([]);
  });

  it('maps one space-wide read and posts later turns to the cached anchor', async () => {
    const { seam, postMessage } = seamStub();
    const listThreads = vi.fn(async () => [{
      rootMessageId: ROOT,
      anchorId: ANCHOR,
      teammateId: TEAMMATE,
      model: 'claude-sonnet-4-5',
      mode: 'ask' as const,
      createdAt: '2026-08-13T08:00:00.000Z',
      lastReplyAt: null,
    }]);
    const port = createChatHomePortFromSeam(seam, { listThreads });

    const rows = await port.listThreads('space-1');
    expect(listThreads).toHaveBeenCalledExactlyOnceWith('space-1');
    expect(rows[0]?.config).toEqual({
      teammateId: TEAMMATE,
      teammateLabel: 'Forge',
      model: 'claude-sonnet-4-5',
      modelLabel: 'claude-sonnet-4-5',
      mode: 'ask',
    });

    await port.postTurn({
      threadRootId: ROOT,
      body: 'Continue.',
      clientMutationId: 'turn-1',
    });
    expect(postMessage).toHaveBeenCalledWith({
      clientMutationId: 'turn-1',
      anchorIds: [ANCHOR],
      parentMessageId: ROOT,
      body: 'Continue.',
    });
  });

  it('creates the first prompt as an ordinary root before config', async () => {
    const { seam, postMessage } = seamStub();
    const configureThread = vi.fn(async (input) => ({
      threadRootId: input.rootMessageId,
      teammateId: input.teammateId,
      model: input.model,
      mode: input.mode,
    }));
    const port = createChatHomePortFromSeam(seam, { configureThread });
    const root = await port.startThread.createRoot({
      spaceId: 'space-1',
      anchorId: ANCHOR,
      body: 'First prompt',
      clientMutationId: 'root-1',
    });

    expect(root).toEqual({ threadRootId: ROOT });
    expect(postMessage).toHaveBeenCalledWith({
      clientMutationId: 'root-1',
      anchorIds: [ANCHOR],
      body: 'First prompt',
    });
  });

  it('self-heals a cache miss with ONE bridge refresh instead of failing the read', async () => {
    const { seam } = seamStub();
    const row = {
      rootMessageId: ROOT,
      anchorId: ANCHOR,
      teammateId: TEAMMATE,
      model: 'claude-sonnet-4-5',
      mode: 'plan' as const,
      createdAt: '2026-08-13T08:00:00.000Z',
      lastReplyAt: null,
    };
    // First read answers EMPTY (the thread missed the last home read); the
    // refresh answers the row. Shipped v1 threw "not present in the latest
    // space-wide read" here — measured live by the operator.
    const listThreads = vi.fn(async () => (listThreads.mock.calls.length > 1 ? [row] : []));
    const port = createChatHomePortFromSeam(seam, { listThreads });
    await port.listThreads('space-1');

    await port.postTurn({ threadRootId: ROOT, body: 'hello again', clientMutationId: 'turn-x' });
    expect(listThreads).toHaveBeenCalledTimes(2);

    // A rootId the server has never heard of still fails honestly.
    await expect(
      port.postTurn({ threadRootId: '019f0000-0000-7000-8000-00000000dead' as EntityId, body: 'x', clientMutationId: 'turn-y' }),
    ).rejects.toThrow(/not present in the latest space-wide read/);
  });

  it('seeds the caches at createRoot so a brand-new chat never races the home read', async () => {
    const { seam, postMessage } = seamStub();
    const configureThread = vi.fn(async () => ({ threadRootId: ROOT, teammateId: TEAMMATE, model: 'm', mode: 'ask' as const }));
    // No listThreads bridge at all: the seeded entry must carry the sequence alone.
    const port = createChatHomePortFromSeam(seam, { configureThread });

    const { threadRootId } = await port.startThread.createRoot({
      spaceId: 'space-1', anchorId: ANCHOR, body: 'first prompt', clientMutationId: 'root-1',
    });
    await port.startThread.configure({
      rootMessageId: threadRootId, teammateId: TEAMMATE, model: 'claude-sonnet-4-5', mode: 'ask', clientMutationId: 'cfg-1',
    });
    await port.postTurn({ threadRootId, body: 'second turn', clientMutationId: 'turn-2' });
    expect(postMessage).toHaveBeenLastCalledWith({
      clientMutationId: 'turn-2',
      anchorIds: [ANCHOR],
      parentMessageId: ROOT,
      body: 'second turn',
    });
  });
});
