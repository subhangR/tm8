import type {
  CommandResult,
  EntityDetail,
  EntityId,
  MessageBatchResult,
  MessageView,
  SpaceId,
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
      },
      state: 'idle',
    }));
  };

  return {
    threadListUnavailableReason: bridge.listThreads ? null : LIST_UNAVAILABLE,
    listThreads,
    listTeammates,
    async readThread(rootMessageId) {
      const item = listCache.get(rootMessageId);
      if (!item) throw new Error('This chat thread is not present in the latest space-wide read.');
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
        })),
      );
      return {
        summary: {
          rootId: item.rootMessageId,
          title: root.content.body || 'Conversation',
          preview: messages[messages.length - 1]?.content.body || 'No text response',
          updatedAt: item.lastReplyAt ?? item.createdAt,
          replyCount: replies.items.length,
          config: {
            teammateId: item.teammateId,
            teammateLabel,
            model: item.model,
            modelLabel: item.model,
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
        });
        return { threadRootId: messageIdFrom(result) };
      },
      async configure(input) {
        if (!bridge.configureThread) throw new Error(START_UNAVAILABLE);
        return bridge.configureThread(input);
      },
    },
    async postTurn(input) {
      const item = listCache.get(input.threadRootId);
      if (!item) throw new Error('This chat thread is not present in the latest space-wide read.');
      const result = await seam.commands.postMessage({
        clientMutationId: input.clientMutationId,
        anchorIds: [item.anchorId],
        parentMessageId: input.threadRootId,
        body: input.body,
      });
      return { messageId: messageIdFrom(result) };
    },
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
