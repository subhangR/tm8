import { describe, expect, it, vi } from 'vitest';
import type { MessageBatchResult, MessageView } from '@tm8/contract';
import { chatStateKey, createChatStore } from './chat-store';
import {
  chatPageWithJournal,
  createChatMutationController,
  reconcileChatMutationEvent,
} from './chat-mutations';

const SESSION = '01900000-0000-7000-8000-000000000301';
const SPACE = '01900000-0000-7000-8000-000000000302';
const key = {
  viewerMemberId: '01900000-0000-7000-8000-000000000303',
  sessionId: SESSION,
  scope: 'session_chat_v1' as const,
  filter: 'chronological',
};

function message(id: string, body = 'stored body'): MessageView {
  return {
    id,
    kind: 'message',
    title: body,
    spaceId: SPACE,
    parentId: SESSION,
    createdAt: '2026-07-30T01:00:00.000Z',
    updatedAt: '2026-07-30T01:00:00.000Z',
    deletedAt: null,
    version: 1,
    createdBy: { id: key.viewerMemberId, displayName: 'You', isAgent: false },
    state: {
      kind: 'message',
      anchorId: SESSION,
      rootMessageId: null,
      author: { id: key.viewerMemberId, displayName: 'You', isAgent: false },
      messageBatchId: 'batch-1',
      editedAt: null,
    },
    content: { kind: 'message', body, mentions: [], attachments: [] },
    counters: { messages: 0, children: 0, connections: 0 },
    capabilities: { canView: true, canEdit: true, canDelete: true, canReact: true, canShare: true },
    replyCount: 0,
  } as unknown as MessageView;
}

function result(id: string, body?: string): MessageBatchResult {
  return { messageBatchId: 'batch-1', messages: [message(id, body)] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup(postMessage = vi.fn()) {
  const store = createChatStore({ storage: null, now: () => '2026-07-30T00:59:00.000Z' });
  store.getState().ensure(key);
  const refresh = vi.fn().mockResolvedValue(undefined);
  const controller = createChatMutationController({
    store,
    key,
    spaceId: SPACE,
    postMessage,
    refresh,
    now: () => '2026-07-30T01:00:00.000Z',
  });
  return { store, controller, postMessage, refresh };
}

describe('stored-first Chat mutation journal', () => {
  it('journals before dispatch, projects one pending bubble, then reconciles to one stored bubble', async () => {
    const pending = deferred<MessageBatchResult>();
    const h = setup(vi.fn().mockReturnValue(pending.promise));
    const submission = h.controller.submit({
      anchorIds: [SESSION], body: 'stored body', parentMessageId: null,
    });

    const during = Object.values(h.store.getState().entries[chatStateKey(key)]!.mutations)[0]!;
    expect(during.clientMutationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(during).toMatchObject({ mutationState: 'pending', storageState: 'unconfirmed' });
    expect(chatPageWithJournal(h.store.getState().entries[chatStateKey(key)]!).items).toHaveLength(1);
    expect(chatPageWithJournal(h.store.getState().entries[chatStateKey(key)]!).items[0]!.itemKind).toBe('message');

    pending.resolve(result('01900000-0000-7000-8000-000000000304'));
    await submission;
    const after = h.store.getState().entries[chatStateKey(key)]!;
    expect(after.mutations[during.clientMutationId]).toMatchObject({
      mutationState: 'settled', storageState: 'stored',
      storedMessageIds: ['01900000-0000-7000-8000-000000000304'],
    });
    const projected = chatPageWithJournal(after);
    expect(projected.items).toHaveLength(1);
    expect(projected.items[0]!.itemId).toBe('01900000-0000-7000-8000-000000000304');
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps a draft on a proven validation/permission rejection and records not_stored', async () => {
    const refusal = Object.assign(new Error('not allowed'), { code: 'forbidden' });
    const h = setup(vi.fn().mockRejectedValue(refusal));
    h.store.getState().setDraft(key, 'draft survives');
    await expect(h.controller.submit({
      anchorIds: [SESSION], body: 'draft survives', parentMessageId: null,
    })).rejects.toBe(refusal);

    const entry = h.store.getState().entries[chatStateKey(key)]!;
    expect(Object.values(entry.mutations)[0]).toMatchObject({
      mutationState: 'rejected', storageState: 'not_stored', error: 'not allowed',
    });
    expect(entry.drafts.newMessage).toBe('draft survives');
    expect(chatPageWithJournal(entry).items).toHaveLength(0);
  });

  it('blocks a second submission after an uncertain outcome until same-id replay reconciles', async () => {
    const post = vi.fn().mockRejectedValueOnce(new TypeError('network ended'));
    const h = setup(post);
    await expect(h.controller.submit({
      anchorIds: [SESSION], body: 'maybe stored', parentMessageId: null,
    })).rejects.toThrow('network ended');
    const uncertain = Object.values(h.store.getState().entries[chatStateKey(key)]!.mutations)[0]!;
    expect(uncertain).toMatchObject({ mutationState: 'uncertain', storageState: 'unknown' });

    await expect(h.controller.submit({
      anchorIds: [SESSION], body: 'duplicate risk', parentMessageId: null,
    })).rejects.toMatchObject({ code: 'mutation_reconciliation_required' });
    expect(post).toHaveBeenCalledTimes(1);

    post.mockResolvedValueOnce(result('01900000-0000-7000-8000-000000000305', 'maybe stored'));
    await h.controller.reconcile(uncertain.clientMutationId);
    expect(post.mock.calls[1]![0].clientMutationId).toBe(post.mock.calls[0]![0].clientMutationId);
    expect(h.store.getState().entries[chatStateKey(key)]!.mutations[uncertain.clientMutationId])
      .toMatchObject({ mutationState: 'settled', storageState: 'stored' });
  });

  it('event echo reconciles first and a later command result is idempotent', async () => {
    const pending = deferred<MessageBatchResult>();
    const h = setup(vi.fn().mockReturnValue(pending.promise));
    const submission = h.controller.submit({
      anchorIds: [SESSION], body: 'echo first', parentMessageId: null,
    });
    const mutation = Object.values(h.store.getState().entries[chatStateKey(key)]!.mutations)[0]!;
    const echoed = message('01900000-0000-7000-8000-000000000306', 'echo first');
    reconcileChatMutationEvent(h.store, chatStateKey(key), {
      type: 'message.created',
      anchorId: SESSION,
      message: echoed,
      clientMutationId: mutation.clientMutationId,
    } as never);
    expect(h.store.getState().entries[chatStateKey(key)]!.mutations[mutation.clientMutationId])
      .toMatchObject({ storageState: 'stored' });

    pending.resolve(result(echoed.id, 'echo first'));
    await submission;
    expect(chatPageWithJournal(h.store.getState().entries[chatStateKey(key)]!).items).toHaveLength(1);
  });

  it('Send again submits the same content under a fresh identity and never mutates delivery state', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce(result('01900000-0000-7000-8000-000000000307'))
      .mockResolvedValueOnce(result('01900000-0000-7000-8000-000000000308'));
    const h = setup(post);
    await h.controller.submit({ anchorIds: [SESSION], body: 'again', parentMessageId: null });
    await h.controller.submit({ anchorIds: [SESSION], body: 'again', parentMessageId: null });
    expect(post.mock.calls[0]![0].clientMutationId).not.toBe(post.mock.calls[1]![0].clientMutationId);
    for (const journal of Object.values(h.store.getState().entries[chatStateKey(key)]!.mutations)) {
      expect(journal).not.toHaveProperty('delivery');
    }
  });
});
