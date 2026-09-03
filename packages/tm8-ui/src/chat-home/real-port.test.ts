import { describe, expect, it, vi } from 'vitest';
import type { EntityId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { createChatHomePortFromSeam } from './real-port';

const CHAT = '019f0000-0000-7000-8000-000000000201' as EntityId;
const ABOUT = '019f0000-0000-7000-8000-000000000202' as EntityId;
const TEAMMATE = '019f0000-0000-7000-8000-000000000203' as EntityId;
const MSG = '019f0000-0000-7000-8000-000000000210' as EntityId;

function chatSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: CHAT,
    kind: 'chat',
    title: 'Plan the launch',
    createdAt: '2026-09-03T08:00:00.000Z',
    activityAt: '2026-09-03T08:00:00.000Z',
    state: {
      kind: 'chat',
      teammateId: TEAMMATE,
      model: 'claude-sonnet-4-5',
      provider: 'anthropic',
      agentTool: 'claude-code',
      mode: 'ask',
      workdirMode: 'scratch',
      projectId: null,
      runtimeState: 'cold',
      turnState: 'idle',
      turnCount: 2,
      lastTurnAt: '2026-09-03T08:05:00.000Z',
    },
    ...overrides,
  };
}

/**
 * The seam every case below shares.
 *
 * `query` answers BY KIND, which is the whole re-key: chats are listed by
 * `entities.list kind=chat` now, the same read every other kind uses, so the
 * stub has to discriminate exactly as the server does.
 */
function seamStub(chats: unknown[] = [chatSummary()]) {
  const postMessage = vi.fn(async () => ({
    entity: { id: MSG, kind: 'message' },
    patches: [],
  }));
  const startChat = vi.fn(async () => ({ chat: chatSummary(), messageId: MSG }));
  const query = vi.fn(async (input: { kinds?: string[] }) => (
    input.kinds?.[0] === 'chat'
      ? { page: { items: chats } }
      : { page: { items: [{ id: TEAMMATE, title: 'Forge' }] } }
  ));
  const connections = vi.fn(async () => ({ items: [] }));
  const seam = {
    query,
    connections,
    commands: { postMessage, startChat },
    onChatTurn: vi.fn(() => () => undefined),
  } as unknown as Seam;
  return { seam, postMessage, startChat, query, connections };
}

describe('real chat-home seam adapter', () => {
  it('has nothing left to be unavailable: both reads are ordinary seam calls', async () => {
    // Before 176 BOTH of these carried a refusal string, because a chat had no
    // kind to list by and no door of its own — the host had to inject a reader
    // and the port had to survive its absence. Neither is injectable now.
    const { seam } = seamStub([]);
    const port = createChatHomePortFromSeam(seam);
    expect(port.threadListUnavailableReason).toBeNull();
    expect(port.startThread.unavailableReason).toBeNull();
    expect(await port.listThreads('space-1')).toEqual([]);
  });

  it('lists chats by kind and posts later turns ANCHORED on the chat', async () => {
    const { seam, postMessage, query } = seamStub();
    const port = createChatHomePortFromSeam(seam);

    const rows = await port.listThreads('space-1');
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ spaceId: 'space-1', kinds: ['chat'] }),
    );
    expect(rows[0]?.rootId).toBe(CHAT);
    expect(rows[0]?.config).toEqual({
      teammateId: TEAMMATE,
      teammateLabel: 'Forge',
      model: 'claude-sonnet-4-5',
      modelLabel: 'claude-sonnet-4-5',
      mode: 'ask',
    });

    await port.postTurn({ chatId: CHAT, body: 'Continue.', clientMutationId: 'turn-1' });
    // THE RE-KEY, stated as an assertion: the anchor is the CHAT and there is
    // no parent. A turn used to be a threaded reply under the root message
    // because the root message WAS the chat.
    expect(postMessage).toHaveBeenCalledWith({
      clientMutationId: 'turn-1',
      anchorIds: [CHAT],
      body: 'Continue.',
    });
    expect(postMessage.mock.calls[0]?.[0]).not.toHaveProperty('parentMessageId');
  });

  it('creates the chat and its opening turn in ONE call', async () => {
    const { seam, postMessage, startChat } = seamStub();
    const port = createChatHomePortFromSeam(seam);
    const created = await port.startThread.create({
      spaceId: 'space-1',
      aboutId: ABOUT,
      body: 'First prompt',
      teammateId: TEAMMATE,
      model: 'claude-sonnet-4-5',
      mode: 'ask',
      clientMutationId: 'start-1',
    });

    expect(created).toEqual({
      chatId: CHAT, teammateId: TEAMMATE, model: 'claude-sonnet-4-5', mode: 'ask',
    });
    expect(startChat).toHaveBeenCalledWith({
      clientMutationId: 'start-1',
      spaceId: 'space-1',
      teammateId: TEAMMATE,
      model: 'claude-sonnet-4-5',
      mode: 'ask',
      workdirMode: 'scratch',
      body: 'First prompt',
      aboutId: ABOUT,
    });
    // No separate root post: the opening message rides the same command.
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('omits an empty attachment list rather than claiming files nobody staged', async () => {
    const { seam, startChat } = seamStub();
    const port = createChatHomePortFromSeam(seam);
    await port.startThread.create({
      spaceId: 'space-1',
      body: 'no files',
      teammateId: TEAMMATE,
      model: 'claude-sonnet-4-5',
      mode: 'ask',
      clientMutationId: 'start-2',
      attachmentIds: [],
    });
    const sent = startChat.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('attachmentIds');
    expect(sent).not.toHaveProperty('aboutId');
  });

  it('needs no cache to post a turn at all, because the chat IS the anchor', async () => {
    // The old port had to resolve a cached row here, to learn which anchor the
    // thread's messages lived on. There is nothing to look up now — a chat
    // anchors its own transcript — so a chat that missed the last list read can
    // still be posted to. That is one whole class of "not present in the latest
    // space-wide read" failure deleted rather than handled.
    const { seam, postMessage } = seamStub([]);
    const port = createChatHomePortFromSeam(seam);
    await port.postTurn({ chatId: CHAT, body: 'straight through', clientMutationId: 'turn-x' });
    expect(postMessage).toHaveBeenCalledWith({
      clientMutationId: 'turn-x',
      anchorIds: [CHAT],
      body: 'straight through',
    });
  });

  it('self-heals a READ cache miss with ONE refresh instead of failing', async () => {
    // The cache is a COALESCER, not an authority: a chat that missed the last
    // list read — another tab's, a just-created one — must not make the
    // transcript unreadable. Shipped v1 threw here, measured live by the
    // operator. `readThread` is where the cache still has a job, because a
    // transcript needs the row's teammate and mode.
    let served: unknown[] = [];
    const { seam } = seamStub();
    const query = vi.fn(async (input: { kinds?: string[] }) => (
      input.kinds?.[0] === 'chat'
        ? { page: { items: served } }
        : { page: { items: [{ id: TEAMMATE, title: 'Forge' }] } }
    ));
    (seam as { query: unknown }).query = query;
    (seam as { messages?: unknown }).messages = vi.fn(async () => ({ items: [] }));
    const port = createChatHomePortFromSeam(seam);
    await port.listThreads('space-1');
    served = [chatSummary()];

    const detail = await port.readThread(CHAT);
    expect(detail.summary.rootId).toBe(CHAT);

    // A chat id the server has never heard of still fails honestly.
    await expect(
      port.readThread('019f0000-0000-7000-8000-00000000dead' as EntityId),
    ).rejects.toThrow(/not present in the latest space-wide read/);
  });

  it('reads a chat FLAT, and previews the last settled message', async () => {
    const { seam } = seamStub();
    const message = (id: string, body: string, extra: Record<string, unknown> = {}) => ({
      id: id as EntityId,
      kind: 'message',
      createdAt: '2026-09-03T08:00:00.000Z',
      createdBy: null,
      state: { kind: 'message', author: null },
      content: { kind: 'message', body },
      ...extra,
    });
    const messages = vi.fn(async () => ({
      items: [
        message('019f0000-0000-7000-8000-000000000204', 'The settled answer.'),
        // The claimed turn: its body is the server's placeholder, and the wire
        // marker says so — the preview must not repeat it.
        message('019f0000-0000-7000-8000-000000000205', 'Agent turn in progress.', { turnInFlight: true }),
      ],
    }));
    (seam as { messages?: unknown }).messages = messages;
    const entity = vi.fn();
    (seam as { entity?: unknown }).entity = entity;
    const port = createChatHomePortFromSeam(seam);
    await port.listThreads('space-1');

    const detail = await port.readThread(CHAT);
    // ONE anchor read, with NO rootMessageId scope: a chat is flat, so there is
    // no thread root to fetch separately and none to filter replies by.
    expect(messages).toHaveBeenCalledWith(CHAT, { limit: 100 });
    expect(entity).not.toHaveBeenCalled();
    expect(detail.summary.preview).toBe('The settled answer.');
    expect(detail.turns.at(-1)?.turnInFlight).toBe(true);
  });

  /**
   * THE DROPPED FIELD. `messages.list` has returned `content.attachments` on
   * every message since the attachments slice landed (`facade/handlers/
   * messages.ts` → `contentOf`), and this adapter was the one place that read
   * `content.body` and stopped — which is the whole reason an uploaded image
   * reached the agent and the graph but never the transcript that sent it.
   *
   * The second half of the case matters as much as the first: a node that
   * predates the field omits it entirely, and an absent list is a message with
   * no files, not a malformed one. `?? []` is what keeps the read from
   * throwing on an older node.
   */
  it('carries each message\'s attachments onto its turn, and tolerates a node that sends none', async () => {
    const { seam } = seamStub();
    const attachment = {
      fileEntityId: '019f0000-0000-7000-8000-000000000041' as EntityId,
      name: 'launch-board.png',
      mime: 'image/png',
    };
    const message = (id: string, body: string, content: Record<string, unknown> = {}) => ({
      id: id as EntityId,
      kind: 'message',
      createdAt: '2026-09-03T08:00:00.000Z',
      createdBy: null,
      state: { kind: 'message', author: null },
      content: { kind: 'message', body, ...content },
    });
    (seam as { messages?: unknown }).messages = vi.fn(async () => ({
      items: [
        message('019f0000-0000-7000-8000-000000000206', 'Look at this', { attachments: [attachment] }),
        // No `attachments` key at all — the older-node shape.
        message('019f0000-0000-7000-8000-000000000207', 'On it.'),
      ],
    }));
    const port = createChatHomePortFromSeam(seam);
    await port.listThreads('space-1');

    const detail = await port.readThread(CHAT);
    expect(detail.turns[0]?.attachments).toEqual([attachment]);
    expect(detail.turns[1]?.attachments).toEqual([]);
  });

  it('seeds the cache at create so a brand-new chat never races the list read', async () => {
    const { seam, postMessage } = seamStub([]);
    const port = createChatHomePortFromSeam(seam);

    const { chatId } = await port.startThread.create({
      spaceId: 'space-1',
      body: 'first prompt',
      teammateId: TEAMMATE,
      model: 'claude-sonnet-4-5',
      mode: 'ask',
      clientMutationId: 'start-1',
    });
    // The list read still answers EMPTY — the seeded entry has to carry this
    // alone, or the first follow-up turn on a brand-new chat throws.
    await port.postTurn({ chatId, body: 'second turn', clientMutationId: 'turn-2' });
    expect(postMessage).toHaveBeenLastCalledWith({
      clientMutationId: 'turn-2',
      anchorIds: [CHAT],
      body: 'second turn',
    });
  });

  it('folds the two server state axes into the one word a row draws', async () => {
    // `runtimeState` is the headless child, `turnState` is the queue. A chat
    // whose node restarted with work waiting is 'stopped' AND 'queued', and the
    // row must read as busy rather than as continuable.
    const busy = chatSummary({
      state: { ...chatSummary().state, runtimeState: 'stopped', turnState: 'queued' },
    });
    const stopped = chatSummary({
      state: { ...chatSummary().state, runtimeState: 'stopped', turnState: 'idle' },
    });
    expect((await createChatHomePortFromSeam(seamStub([busy]).seam).listThreads('s'))[0]?.state)
      .toBe('streaming');
    expect((await createChatHomePortFromSeam(seamStub([stopped]).seam).listThreads('s'))[0]?.state)
      .toBe('stopped-continuable');
  });
});
