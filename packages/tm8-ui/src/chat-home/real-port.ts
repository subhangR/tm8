import type {
  CommandResult,
  EntityDetail,
  EntityId,
  MessageBatchResult,
  MessageView,
  SpaceId,
  ChatMode,
} from '@tm8/contract';
import type { Seam } from '../data/seam';
import { createChatHomeFixturePort } from './fixtures';
import { turnPartFromMessagePart } from './wire';
import type {
  ChatConfigureInput,
  ChatHomePort,
  ChatStartResult,
  ChatThreadDetail,
  ChatThreadSummary,
  ChatTurnPart,
} from './types';

/** The ruled minimal item from the L2 spaces.home chatThreads read. */
export interface ChatThreadListItem {
  rootMessageId: EntityId;
  anchorId: EntityId;
  teammateId: EntityId;
  model: string;
  mode: ChatMode;
  createdAt: string;
  lastReplyAt: string | null;
  /** PR188 review F4: root body excerpt so rows are distinguishable. */
  title?: string | null;
  replyCount?: number;
}

/** Injection points owned by L2. Every existing-seam operation is wired below. */
export interface ChatHomeL2Bridge {
  listThreads?(spaceId: SpaceId | string): Promise<readonly ChatThreadListItem[]>;
  readParts?(messageId: EntityId): Promise<readonly ChatTurnPart[]>;
  configureThread?(input: ChatConfigureInput): Promise<ChatStartResult>;
  /**
   * `chat.threads.interrupt`. Absent ⇒ this node cannot stop a running turn,
   * and the composer says so on the control rather than hiding it.
   */
  interruptThread?(rootMessageId: EntityId): Promise<void>;
}

const LIST_UNAVAILABLE =
  'Conversation history is unavailable on this node because the space-wide chatThreads read has not landed yet.';
const START_UNAVAILABLE =
  'New chat is unavailable on this node because the write-once thread configuration operation has not landed yet.';

export function createChatHomePortFromSeam(
  seam: Seam,
  bridge: ChatHomeL2Bridge = {},
): ChatHomePort {
  if ('fixtureControls' in seam) return createChatHomeFixturePort().port;

  const listCache = new Map<EntityId, ChatThreadListItem>();
  const listSpaceCache = new Map<EntityId, SpaceId | string>();
  /** The last space this port listed — the self-heal refresh needs a scope. */
  let lastSpaceId: SpaceId | string | null = null;

  /**
   * Post-ship fix (2026-08-13, "This chat thread is not present in the latest
   * space-wide read" hit live): the cache is a COALESCER, not an authority.
   * A thread that exists on the server but missed the last home read — a
   * just-created chat, a re-created port, another tab's new thread — must not
   * make the surface unreadable. On a miss, refresh ONCE from the bridge and
   * only then fail with the honest message.
   */
  const resolveItem = async (rootMessageId: EntityId): Promise<ChatThreadListItem> => {
    const cached = listCache.get(rootMessageId);
    if (cached) return cached;
    if (lastSpaceId !== null && bridge.listThreads) {
      await listThreads(lastSpaceId);
      const refreshed = listCache.get(rootMessageId);
      if (refreshed) return refreshed;
    }
    throw new Error('This chat thread is not present in the latest space-wide read.');
  };

  const listTeammates: ChatHomePort['listTeammates'] = async (spaceId) => {
    const result = await seam.query({
      spaceId,
      kinds: ['team_member'],
      sort: 'activityAt_desc',
      limit: 100,
    });
    return result.page.items.map((item) => ({
      id: item.id,
      label: item.title,
      avatar: null,
    }));
  };

  const listThreads: ChatHomePort['listThreads'] = async (spaceId) => {
    lastSpaceId = spaceId;
    if (!bridge.listThreads) return [];
    const items = await bridge.listThreads(spaceId);
    for (const item of items) {
      listCache.set(item.rootMessageId, item);
      listSpaceCache.set(item.rootMessageId, spaceId);
    }
    const teammates = await listTeammates(spaceId);
    const labels = new Map(teammates.map((teammate) => [teammate.id, teammate.label]));
    return items.map<ChatThreadSummary>((item) => ({
      rootId: item.rootMessageId,
      anchorId: item.anchorId,
      // F4: the root body is the only honest title a chat has. The literal
      // 'Conversation' made every real row identical while the fixture port
      // showed real titles — exactly the class of demo-only truth.
      title: item.title?.trim() || 'Conversation',
      preview: item.title?.trim() || 'Open to read this thread',
      updatedAt: item.lastReplyAt ?? item.createdAt,
      replyCount: item.replyCount ?? 0,
      config: {
        teammateId: item.teammateId,
        teammateLabel: labels.get(item.teammateId) ?? 'Agent teammate',
        model: item.model,
        modelLabel: item.model,
        mode: item.mode,
      },
      state: 'idle',
    }));
  };

  return {
    threadListUnavailableReason: bridge.listThreads ? null : LIST_UNAVAILABLE,
    listThreads,
    listTeammates,
    async readThread(rootMessageId) {
      const item = await resolveItem(rootMessageId);
      const [rootDetail, replies, teammates] = await Promise.all([
        seam.entity(rootMessageId),
        seam.messages(item.anchorId, { rootMessageId, limit: 100 }),
        listTeammates(listSpaceCache.get(rootMessageId) ?? ''),
      ]);
      const root = messageFromDetail(rootDetail);
      const teammateLabel = teammates.find((teammate) => teammate.id === item.teammateId)?.label ?? 'Agent teammate';
      const messages = [root, ...replies.items];
      const turns = await Promise.all(
        messages.map(async (message) => ({
          messageId: message.id,
          role: message.state.author?.isAgent ? 'assistant' as const : 'user' as const,
          author: message.state.author ?? message.createdBy ?? null,
          createdAt: message.createdAt,
          body: message.content.body,
          // F4/F1: the server already returns MessagePart[] on the message
          // view (MessageView.parts, L2's additive field), normalized through
          // wire.ts; a supplied readParts bridge stays as an override.
          parts: message.parts
            ? message.parts.map(turnPartFromMessagePart)
            : bridge.readParts ? [...await bridge.readParts(message.id)] : [],
          // The server has returned these on every message read all along
          // (`contentOf` → `content.attachments`); this adapter was the one
          // place that dropped them, so an uploaded image reached the agent
          // and the durable graph but never the transcript that sent it. `??
          // []` because a node older than the attachments slice omits the
          // field entirely, and an absent list is not a malformed message.
          attachments: message.content.attachments ?? [],
          ...(message.turnInFlight ? { turnInFlight: true } : {}),
        })),
      );
      return {
        summary: {
          rootId: item.rootMessageId,
          anchorId: item.anchorId,
          title: root.content.body || 'Conversation',
          // An in-flight turn's body is the claim placeholder ('Agent turn in
          // progress.'), not content — preview the last settled message instead.
          preview: [...messages].reverse().find((message) => !message.turnInFlight)?.content.body
            || 'No text response',
          updatedAt: item.lastReplyAt ?? item.createdAt,
          replyCount: replies.items.length,
          config: {
            teammateId: item.teammateId,
            teammateLabel,
            model: item.model,
            modelLabel: item.model,
            mode: item.mode,
          },
          state: 'idle',
        },
        turns,
      } satisfies ChatThreadDetail;
    },
    startThread: {
      unavailableReason: bridge.configureThread ? null : START_UNAVAILABLE,
      async createRoot(input) {
        const result = await seam.commands.postMessage({
          clientMutationId: input.clientMutationId,
          anchorIds: [input.anchorId],
          body: input.body,
          /* Omitted rather than sent empty: the server validates the array
             when it is present, and an empty one is a claim about files
             nobody staged. */
          ...(input.attachmentIds?.length ? { attachmentIds: input.attachmentIds } : {}),
        });
        const threadRootId = messageIdFrom(result);
        // Seed the caches from what THIS port just wrote, so the immediate
        // configure -> read -> post sequence never races the next home read.
        // teammateId/model are provisional until configure() fills them.
        listCache.set(threadRootId, {
          rootMessageId: threadRootId,
          anchorId: input.anchorId,
          teammateId: '' as EntityId,
          model: '',
          mode: 'ask',
          createdAt: new Date().toISOString(),
          lastReplyAt: null,
          title: input.body,
        });
        listSpaceCache.set(threadRootId, input.spaceId);
        lastSpaceId = input.spaceId;
        return { threadRootId };
      },
      async configure(input) {
        if (!bridge.configureThread) throw new Error(START_UNAVAILABLE);
        const result = await bridge.configureThread(input);
        const seeded = listCache.get(input.rootMessageId);
        if (seeded) {
          listCache.set(input.rootMessageId, {
            ...seeded,
            teammateId: input.teammateId,
            model: input.model,
            mode: input.mode,
          });
        }
        return result;
      },
    },
    async postTurn(input) {
      const item = await resolveItem(input.threadRootId);
      const result = await seam.commands.postMessage({
        clientMutationId: input.clientMutationId,
        anchorIds: [item.anchorId],
        parentMessageId: input.threadRootId,
        body: input.body,
        ...(input.attachmentIds?.length ? { attachmentIds: input.attachmentIds } : {}),
        // The per-turn model rides on the message, exactly as attachments do.
        ...(input.model ? { model: input.model } : {}),
      });
      return { messageId: messageIdFrom(result) };
    },
    /**
     * STOP.
     *
     * Present only when L2 supplied the bridge, and that optionality is the
     * whole point: the composer draws a live Stop when `port.interrupt` exists
     * and a disabled loader WITH ITS REASON when it does not, so a node without
     * the operation never looks as though stopping simply went unconsidered.
     *
     * Before this, no port supplied it and every real chat took the second
     * branch — the affordance was designed, built, tested against the fixture
     * port, and unreachable in the app. That was the whole of "there is no
     * option to stop".
     */
    ...(bridge.interruptThread
      ? {
        async interrupt(threadRootId: EntityId): Promise<void> {
          await bridge.interruptThread!(threadRootId);
        },
      }
      : {}),
    subscribe(listener) {
      return seam.onChatTurn(listener);
    },
  };
}

function messageIdFrom(result: CommandResult | MessageBatchResult): EntityId {
  if ('messages' in result) {
    if (result.messages[0]) return result.messages[0].id;
    throw new Error('messages.post returned an empty message batch.');
  }
  if (result.entity?.kind === 'message') return result.entity.id;
  const message = result.patches.find((patch) => patch.kind === 'message');
  if (message) return message.id;
  throw new Error('messages.post stored no message in its result.');
}

function messageFromDetail(detail: EntityDetail): MessageView {
  if (detail.kind !== 'message' || detail.state.kind !== 'message' || detail.content.kind !== 'message') {
    throw new Error(`Chat root ${detail.id} is not a message.`);
  }
  return detail as unknown as MessageView;
}
