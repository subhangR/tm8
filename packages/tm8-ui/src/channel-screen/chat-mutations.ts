import type { StoreApi } from 'zustand/vanilla';
import type {
  CommandResult,
  DurableWorkspaceEvent,
  EntityFeedPage,
  FeedItem,
  MessageBatchResult,
  MessageView,
  PostMessageInput,
  SpaceId,
} from '@tm8/contract';
import type { ChannelPostInput } from './feed-model';
import type {
  ChatEntry,
  ChatMutationJournalEntry,
  ChatStateKeyParts,
  ChatStoreState,
} from './chat-store';
import { chatStateKey } from './chat-store';

const PROVEN_NOT_STORED = new Set([
  'invalid_input',
  'forbidden',
  'not_found',
  'conflict',
  'limit_exceeded',
  'invariant_violation',
]);

export interface ChatMutationControllerOptions {
  store: StoreApi<ChatStoreState>;
  key: ChatStateKeyParts;
  spaceId: SpaceId | string;
  postMessage(input: PostMessageInput): Promise<CommandResult | MessageBatchResult>;
  refresh(): Promise<void>;
  now?: () => string;
  newMutationId?: () => string;
}

export interface ChatMutationController {
  submit(input: ChannelPostInput): Promise<void>;
  reconcile(clientMutationId: string): Promise<void>;
}

export class ChatMutationBlockedError extends Error {
  readonly code = 'mutation_reconciliation_required';
  constructor() {
    super('A previous send has an unknown storage outcome. Reconcile that submission before sending another.');
    this.name = 'ChatMutationBlockedError';
  }
}

export function createChatMutationController({
  store,
  key,
  spaceId,
  postMessage,
  refresh,
  now = () => new Date().toISOString(),
  newMutationId = uuidV7,
}: ChatMutationControllerOptions): ChatMutationController {
  const keyId = chatStateKey(key);
  store.getState().ensure(key);

  const run = async (journal: ChatMutationJournalEntry): Promise<void> => {
    try {
      const result = await postMessage(journal.command);
      const messages = messagesFromResult(result);
      settleStored(store, keyId, journal.clientMutationId, messages);
      await refresh();
    } catch (reason: unknown) {
      // An event echo can prove storage before the HTTP request reports its
      // own failure. Stored truth wins; the late rejection cannot regress it.
      const latest = store.getState().entries[keyId]?.mutations[journal.clientMutationId];
      if (latest?.storageState === 'stored') return;
      const code = errorCode(reason);
      const known = code !== null && PROVEN_NOT_STORED.has(code);
      patchMutation(store, keyId, journal.clientMutationId, (current) => ({
        ...current,
        mutationState: known ? 'rejected' : 'uncertain',
        storageState: known ? 'not_stored' : 'unknown',
        error: errorMessage(reason),
      }));
      throw reason;
    }
  };

  return {
    async submit(input) {
      const entry = store.getState().entries[keyId]!;
      if (Object.values(entry.mutations).some((mutation) =>
        mutation.mutationState === 'uncertain' || mutation.mutationState === 'reconciling')) {
        throw new ChatMutationBlockedError();
      }
      const clientMutationId = newMutationId();
      const command: PostMessageInput = {
        clientMutationId,
        anchorIds: [key.sessionId],
        body: input.body,
        parentMessageId: input.parentMessageId,
        ...(input.mentionIds?.length ? { mentionIds: input.mentionIds } : {}),
        ...(input.attachmentIds?.length ? { attachmentIds: input.attachmentIds } : {}),
      };
      const journal: ChatMutationJournalEntry = {
        clientMutationId,
        command,
        mutationState: 'pending',
        storageState: 'unconfirmed',
        storedMessageIds: [],
        createdAt: now(),
        error: null,
        spaceId,
      };
      store.getState().patch(keyId, (current) => ({
        ...current,
        mutations: { ...current.mutations, [clientMutationId]: journal },
      }));
      await run(journal);
    },

    async reconcile(clientMutationId) {
      const journal = store.getState().entries[keyId]?.mutations[clientMutationId];
      if (!journal || journal.mutationState !== 'uncertain') return;
      patchMutation(store, keyId, clientMutationId, (current) => ({
        ...current,
        mutationState: 'reconciling',
        error: null,
      }));
      await run({ ...journal, mutationState: 'reconciling', error: null });
    },
  };
}

/** Feed truth plus only those journal entries whose storage is not yet known. */
export function chatPageWithJournal(entry: ChatEntry): EntityFeedPage {
  const base: EntityFeedPage = entry.page ?? {
    resolvedScope: entry.key.scope,
    predicates: ['anchored'],
    items: [],
    nextCursor: null,
  };
  const optimistic = Object.values(entry.mutations)
    .filter((mutation) => mutation.storageState === 'unconfirmed' || mutation.storageState === 'unknown')
    .map((mutation) => optimisticItem(entry, mutation));
  return {
    ...base,
    items: dedupeAndSort([...base.items, ...optimistic]),
  };
}

/** Event echo is a first-wins reconciliation path beside the command result. */
export function reconcileChatMutationEvent(
  store: StoreApi<ChatStoreState>,
  keyId: string,
  event: DurableWorkspaceEvent,
): boolean {
  if (event.type !== 'message.created' || !event.clientMutationId) return false;
  const entry = store.getState().entries[keyId];
  if (!entry?.mutations[event.clientMutationId]) return false;
  settleStored(store, keyId, event.clientMutationId, [event.message]);
  return true;
}

function settleStored(
  store: StoreApi<ChatStoreState>,
  keyId: string,
  clientMutationId: string,
  messages: readonly MessageView[],
): void {
  const completed = store.getState().entries[keyId]?.mutations[clientMutationId];
  if (!completed) return;
  store.getState().patch(keyId, (entry) => {
    const journal = entry.mutations[clientMutationId];
    if (!journal) return entry;
    const items = messages.map((message) => storedItem(message));
    const page = items.length > 0
      ? {
          ...(entry.page ?? {
            resolvedScope: entry.key.scope,
            predicates: ['anchored'] as const,
            nextCursor: null,
          }),
          items: dedupeAndSort([...(entry.page?.items ?? []), ...items]),
        }
      : entry.page;
    return {
      ...entry,
      ...(page ? { page } : {}),
      mutations: {
        ...entry.mutations,
        [clientMutationId]: {
          ...journal,
          mutationState: 'settled',
          storageState: 'stored',
          storedMessageIds: messages.map((message) => message.id),
          error: null,
        },
      },
    };
  });
  {
    const command = completed.command;
    const entry = store.getState().entries[keyId];
    if (entry) {
      store.getState().setDraft(entry.key, '', command.parentMessageId ?? null);
      if (command.parentMessageId && entry.replyToId === command.parentMessageId) {
        store.getState().setReplyTarget(keyId, null);
      }
    }
  }
}

function patchMutation(
  store: StoreApi<ChatStoreState>,
  keyId: string,
  clientMutationId: string,
  update: (entry: ChatMutationJournalEntry) => ChatMutationJournalEntry,
): void {
  store.getState().patch(keyId, (entry) => {
    const journal = entry.mutations[clientMutationId];
    if (!journal) return entry;
    return {
      ...entry,
      mutations: { ...entry.mutations, [clientMutationId]: update(journal) },
    };
  });
}

function optimisticItem(entry: ChatEntry, journal: ChatMutationJournalEntry): FeedItem {
  const command = journal.command;
  const actor = {
    id: entry.key.viewerMemberId,
    kind: 'member' as const,
    displayName: 'You',
    isAgent: false,
  };
  const message = {
    id: journal.clientMutationId,
    kind: 'message',
    title: command.body.slice(0, 80),
    spaceId: journal.spaceId,
    parentId: command.parentMessageId ?? null,
    createdAt: journal.createdAt,
    updatedAt: journal.createdAt,
    deletedAt: null,
    version: 0,
    createdBy: actor,
    state: {
      kind: 'message',
      anchorId: entry.key.sessionId,
      rootMessageId: command.parentMessageId ?? null,
      author: actor,
      messageBatchId: null,
      editedAt: null,
    },
    content: { kind: 'message', body: command.body, mentions: [], attachments: [] },
    counters: { messages: 0, children: 0, connections: 0 },
    replyCount: 0,
    pending: true,
  } as unknown as MessageView;
  return {
    itemId: journal.clientMutationId,
    createdAt: journal.createdAt,
    sortId: `${journal.createdAt}#${journal.clientMutationId}`,
    via: ['anchored'],
    actor,
    sourceWorkSessionId: null,
    anchor: null,
    logicalOperationId: null,
    itemKind: 'message',
    message,
    delivery: [],
  };
}

function storedItem(message: MessageView): FeedItem {
  return {
    itemId: message.id,
    createdAt: message.createdAt,
    sortId: `${message.createdAt}#${message.id}`,
    via: ['anchored'],
    actor: message.state.author ?? message.createdBy,
    sourceWorkSessionId: null,
    anchor: null,
    logicalOperationId: message.state.messageBatchId,
    itemKind: 'message',
    message,
    delivery: [],
  };
}

function messagesFromResult(result: CommandResult | MessageBatchResult): MessageView[] {
  if ('messages' in result) return result.messages;
  if (result.entity?.kind === 'message') return [result.entity as unknown as MessageView];
  return result.patches.filter((patch): patch is MessageView =>
    patch.kind === 'message' && 'content' in patch);
}

function dedupeAndSort(items: readonly FeedItem[]): FeedItem[] {
  const seen = new Set<string>();
  return items
    .filter((item) => {
      const id = `${item.itemKind}:${item.itemId}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.itemId.localeCompare(b.itemId));
}

function errorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'The message storage outcome is unknown.';
}

/** RFC 9562 UUIDv7: 48-bit Unix milliseconds, version 7, RFC variant, random tail. */
export function uuidV7(nowMs = Date.now()): string {
  const time = Math.max(0, Math.floor(nowMs)).toString(16).padStart(12, '0').slice(-12);
  const bytes = new Uint8Array(10);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  const random = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const variant = ((parseInt(random[3]!, 16) & 0x3) | 0x8).toString(16);
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(0, 3)}-${variant}${random.slice(4, 7)}-${random.slice(7, 19)}`;
}
