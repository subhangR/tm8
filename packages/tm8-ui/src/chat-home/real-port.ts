import type {
  ChatMode,
  EntityId,
  EntitySummary,
  MessageBatchResult,
  MessageView,
  SpaceId,
  CommandResult,
} from '@tm8/contract';
import type { Seam } from '../data/seam';
import { createChatHomeFixturePort } from './fixtures';
import { turnPartFromMessagePart } from './wire';
import type {
  ChatCreateInput,
  ChatHomePort,
  ChatStartResult,
  ChatThreadDetail,
  ChatThreadSummary,
  ChatTurnPart,
} from './types';

/**
 * The chat facts this port needs off a listed row.
 *
 * IT IS NO LONGER A BRIDGE-SUPPLIED SHAPE (176). Before the chat entity, this
 * came from `spaces.home`'s bespoke `chatThreads` projection, which existed
 * only because a chat had no kind to list by — so the host had to inject a
 * reader and the port had to survive its absence. A chat is an entity now, so
 * this is folded from an ordinary `EntitySummary` with `state.kind === 'chat'`,
 * the same read every other list in the product uses.
 */
interface ChatListItem {
  chatId: EntityId;
  aboutId: EntityId | null;
  teammateId: EntityId;
  model: string;
  mode: ChatMode;
  createdAt: string;
  lastTurnAt: string | null;
  title: string | null;
  turnCount: number;
  state: ChatThreadSummary['state'];
}

/**
 * Injection points still owned by the host. `listThreads` and `configureThread`
 * are GONE: both were workarounds for a chat that was not an entity, and both
 * are now ordinary seam calls. `readParts` stays as a test/override seam.
 */
export interface ChatHomeL2Bridge {
  readParts?(messageId: EntityId): Promise<readonly ChatTurnPart[]>;
}

function itemFromSummary(summary: EntitySummary, aboutId: EntityId | null): ChatListItem | null {
  if (summary.state?.kind !== 'chat') return null;
  const state = summary.state;
  return {
    chatId: summary.id,
    aboutId,
    teammateId: state.teammateId,
    model: state.model,
    mode: state.mode,
    createdAt: summary.createdAt,
    lastTurnAt: state.lastTurnAt,
    title: summary.title,
    turnCount: state.turnCount,
    // The two axes the server projects separately, folded to the one word this
    // surface draws. `turnState` is the queue, `runtimeState` the child: a
    // chat with nothing queued whose runtime stopped is continuable, which is
    // a different thing from idle and the composer says so.
    state: state.turnState === 'running' || state.turnState === 'queued'
      ? 'streaming'
      : state.runtimeState === 'stopped' ? 'stopped-continuable' : 'idle',
  };
}

export function createChatHomePortFromSeam(
  seam: Seam,
  bridge: ChatHomeL2Bridge = {},
): ChatHomePort {
  if ('fixtureControls' in seam) return createChatHomeFixturePort().port;

  const listCache = new Map<EntityId, ChatListItem>();
  const listSpaceCache = new Map<EntityId, SpaceId | string>();
  /** The last space this port listed — the self-heal refresh needs a scope. */
  let lastSpaceId: SpaceId | string | null = null;

  /**
   * Post-ship fix (2026-08-13, "This chat thread is not present in the latest
   * space-wide read" hit live): the cache is a COALESCER, not an authority.
   * A chat that exists on the server but missed the last list read — a
   * just-created one, a re-created port, another tab's new chat — must not make
   * the surface unreadable. On a miss, refresh ONCE and only then fail.
   */
  const resolveItem = async (chatId: EntityId): Promise<ChatListItem> => {
    const cached = listCache.get(chatId);
    if (cached) return cached;
    if (lastSpaceId !== null) {
      await listThreads(lastSpaceId);
      const refreshed = listCache.get(chatId);
      if (refreshed) return refreshed;
    }
    throw new Error('This chat is not present in the latest space-wide read.');
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

  /**
   * The `about` target per chat.
   *
   * ONE READ PER CHAT, AND NAMED AS SUCH. A chat's subject is an edge, and no
   * list read carries edges — so preserving the one host that scopes by it
   * (Craft's picker, `thread.anchorId === selectedId`) costs a `connections`
   * call each. It is bounded by the chat list itself, which is small by
   * construction, and it is the honest Wave-1 shape: Wave 2's UI lane draws the
   * `about` relation on the panel and this read moves with it.
   */
  const aboutTargets = async (
    chatIds: readonly EntityId[],
  ): Promise<Map<EntityId, EntityId | null>> => {
    const pairs = await Promise.all(chatIds.map(async (chatId) => {
      try {
        const page = await seam.connections(chatId, { types: ['about'], direction: 'outgoing', limit: 1 });
        return [chatId, page.items[0]?.target.id ?? null] as const;
      } catch {
        // A subject that cannot be read is not a reason to fail the list.
        return [chatId, null] as const;
      }
    }));
    return new Map(pairs);
  };

  const listThreads: ChatHomePort['listThreads'] = async (spaceId) => {
    lastSpaceId = spaceId;
    const [result, teammates] = await Promise.all([
      seam.query({ spaceId, kinds: ['chat'], sort: 'activityAt_desc', limit: 100 }),
      listTeammates(spaceId),
    ]);
    const labels = new Map(teammates.map((teammate) => [teammate.id, teammate.label]));
    const subjects = await aboutTargets(result.page.items.map((item) => item.id));
    const items = result.page.items
      .map((summary) => itemFromSummary(summary, subjects.get(summary.id) ?? null))
      .filter((item): item is ChatListItem => item !== null);
    for (const item of items) {
      listCache.set(item.chatId, item);
      listSpaceCache.set(item.chatId, spaceId);
    }
    return items.map<ChatThreadSummary>((item) => ({
      rootId: item.chatId,
      anchorId: (item.aboutId ?? item.chatId) as EntityId,
      title: item.title?.trim() || 'Conversation',
      preview: item.title?.trim() || 'Open to read this chat',
      updatedAt: item.lastTurnAt ?? item.createdAt,
      // Turns, not replies: a chat is flat, so there is no reply count to give.
      // Each turn is one human message, which is the number this row meant.
      replyCount: item.turnCount,
      config: {
        teammateId: item.teammateId,
        teammateLabel: labels.get(item.teammateId) ?? 'Agent teammate',
        model: item.model,
        modelLabel: item.model,
        mode: item.mode,
      },
      state: item.state,
    }));
  };

  return {
    // The space-wide read is `entities.list kind=chat` — an ordinary list every
    // node that has the chat kind serves. There is nothing left to be
    // unavailable, so this is unconditionally null.
    threadListUnavailableReason: null,
    listThreads,
    listTeammates,
    async readThread(chatId) {
      const item = await resolveItem(chatId);
      // FLAT (176 §1.3). Every message of a chat is anchored ON the chat with
      // no thread root, so this is one ordinary anchor read — no root detail to
      // fetch separately, and no `{ rootMessageId }` scope to pass. The
      // user->agent pairing that threading used to express lives in chat_turns.
      const [page, teammates] = await Promise.all([
        seam.messages(chatId, { limit: 100 }),
        listTeammates(listSpaceCache.get(chatId) ?? lastSpaceId ?? ''),
      ]);
      const teammateLabel = teammates.find((teammate) => teammate.id === item.teammateId)?.label
        ?? 'Agent teammate';
      const messages = page.items;
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
          rootId: item.chatId,
          anchorId: (item.aboutId ?? item.chatId) as EntityId,
          title: item.title?.trim() || 'Conversation',
          // An in-flight turn's body is the claim placeholder ('Agent turn in
          // progress.'), not content — preview the last settled message instead.
          preview: [...messages].reverse().find((message) => !message.turnInFlight)?.content.body
            || 'No text response',
          updatedAt: item.lastTurnAt ?? item.createdAt,
          replyCount: item.turnCount,
          config: {
            teammateId: item.teammateId,
            teammateLabel,
            model: item.model,
            modelLabel: item.model,
            mode: item.mode,
          },
          state: item.state,
        },
        turns,
      } satisfies ChatThreadDetail;
    },
    startThread: {
      unavailableReason: null,
      async create(input: ChatCreateInput): Promise<ChatStartResult> {
        const result = await seam.commands.startChat({
          clientMutationId: input.clientMutationId,
          spaceId: input.spaceId as SpaceId,
          teammateId: input.teammateId,
          model: input.model,
          mode: input.mode,
          // Held at today's behaviour ON PURPOSE: the project picker is the
          // follow-up UI change, and sending anything else from here would pick
          // a directory on the human's behalf through a control they cannot yet
          // see. Every chat, scratch included, gets the full tool set in
          // whatever directory it is bound to.
          workdirMode: 'scratch',
          body: input.body,
          ...(input.aboutId ? { aboutId: input.aboutId } : {}),
          /* Omitted rather than sent empty: the server validates the array when
             it is present, and an empty one is a claim about files nobody
             staged. */
          ...(input.attachmentIds?.length ? { attachmentIds: input.attachmentIds } : {}),
        });
        const item = itemFromSummary(result.chat, input.aboutId ?? null);
        // Seed the cache from what THIS port just wrote, so the immediate
        // create -> read -> post sequence never races the next list read.
        if (item) {
          listCache.set(item.chatId, item);
          listSpaceCache.set(item.chatId, input.spaceId);
        }
        lastSpaceId = input.spaceId;
        return {
          chatId: result.chat.id,
          teammateId: input.teammateId,
          model: input.model,
          mode: input.mode,
        };
      },
    },
    async postTurn(input) {
      // ANCHORED ON THE CHAT, and with no parent. That is the whole re-key: a
      // turn used to be a threaded reply under the root message because the
      // root message WAS the chat. Now the chat is the anchor, the server's
      // batch RPC sees a chat anchor and queues the turn, and it does so for
      // whoever wrote it — a human here, a work session or another chat
      // elsewhere.
      const result = await seam.commands.postMessage({
        clientMutationId: input.clientMutationId,
        anchorIds: [input.chatId],
        body: input.body,
        ...(input.attachmentIds?.length ? { attachmentIds: input.attachmentIds } : {}),
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

export type { MessageView };
