import type { ChatMode, ChatWorkdirMode, CommandResult, EntityId, EntitySummary, MessageBatchResult, MessageView, SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import {
  CHAT_HOME_FIXTURE_THREAD,
  ENTITY_CHAT_THREADS,
  createChatHomeFixturePort,
} from './fixtures';
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
  workdirMode: ChatWorkdirMode;
  projectId: EntityId | null;
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
    workdirMode: state.workdirMode,
    projectId: state.projectId,
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
  /*
   * THE FIXTURE APP'S CHATS. The demo thread plus the conversations behind the
   * entity fixtures' chat ROWS — without those, opening `ent-chat-launch` from
   * the Chats list or from a chip renders "This chat is not present in the
   * latest space-wide read", because the list and the transcript are served by
   * two different fixture datasets that did not know about each other.
   *
   * Supplied HERE rather than as the port factory's default: ~40 focused tests
   * construct that port with no arguments and depend on the cold-start
   * auto-open landing on the single demo thread.
   */
  if ('fixtureControls' in seam) {
    return createChatHomeFixturePort([CHAT_HOME_FIXTURE_THREAD, ...ENTITY_CHAT_THREADS]).port;
  }

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
    return result.page.items.map((item) => {
      const state = item.state?.kind === 'team_member' ? item.state : null;
      return {
        id: item.id,
        label: item.title,
        avatar: null,
        // ADDITIVE (ac_11): absent on a node that does not project them, and
        // absent is passed through as absent so no filter pretends to know.
        ...(state && 'mode' in state ? { mode: state.mode ?? null } : {}),
        ...(state && 'permissionMode' in state ? { permissionMode: state.permissionMode ?? null } : {}),
      };
    });
  };

  const listProjects: NonNullable<ChatHomePort['listProjects']> = async (spaceId) => {
    const result = await seam.query({
      spaceId,
      kinds: ['project'],
      sort: 'activityAt_desc',
      limit: 100,
    });
    return result.page.items.map((item) => ({ id: item.id, name: item.title }));
  };

  /**
   * The `about` target of ONE chat — read when that chat is OPENED.
   *
   * Wave 1 read this for every row of every list (`aboutTargets`, one
   * `connections` call per chat) so that Craft's picker could filter by
   * subject. That was a documented N+1 on the one read whose count scales with
   * the space, and it is gone: the list no longer claims to know each chat's
   * subject, `readThread` answers for the chat actually on screen, and a host
   * that wants "the chats about X" asks X (see `chatIdsAbout`).
   *
   * A subject that cannot be read is not a reason to fail the thread.
   */
  const aboutTargetOf = async (chatId: EntityId): Promise<EntityId | null> => {
    try {
      const page = await seam.connections(chatId, {
        types: ['about'], direction: 'outgoing', limit: 1,
      });
      return page.items[0]?.target.id ?? null;
    } catch {
      return null;
    }
  };

  /**
   * WHICH MESSAGES WERE AUTHORED FROM SOMEWHERE ELSE — one `entities.feed`
   * read beside the transcript's own.
   *
   * WHY A SECOND READ AND NOT A REPLACEMENT. `messages.list` is the
   * transcript's read: it is ordered for a transcript, paged for a transcript,
   * and it is what every chat-home test drives. `entities.feed` is the only
   * op that projects `authored_from` (`FeedItem.sourceWorkSessionId`,
   * feed-context.ts:731), and it also carries activity rows this surface does
   * not draw. So the provenance rides alongside rather than replacing a read
   * that works — one extra call per thread OPEN, not per message and not per
   * row of any list.
   *
   * SOFT-FAILS TO AN EMPTY MAP. A node that cannot serve the feed for a chat
   * anchor renders the transcript exactly as it does today; every bubble is
   * first-party, which is what the surface assumed before this existed. A
   * provenance read is an enhancement to a conversation, never a gate on
   * reading it.
   */
  const provenanceOf = async (chatId: EntityId): Promise<Map<EntityId, EntityId>> => {
    const out = new Map<EntityId, EntityId>();
    try {
      const page = await seam.feed(chatId, { limit: 100 });
      for (const item of page.items) {
        if (item.itemKind !== 'message') continue;
        const source = item.sourceWorkSessionId;
        if (source) out.set(item.message.id, source);
      }
    } catch {
      // See the docblock: absent provenance is the pre-existing rendering.
    }
    return out;
  };

  const chatIdsAbout: ChatHomePort['chatIdsAbout'] = async (aboutId) => {
    try {
      const page = await seam.connections(aboutId, {
        types: ['about'], direction: 'incoming', limit: 100,
      });
      /* The edge accepts every source kind, so the incoming side of `about` on
         a blueprint carries memories as well as chats. The caller intersects
         with its own chat list, and this returns the ids verbatim rather than
         second-guessing which of them is a chat — that is a question the list
         it will be intersected with already answers. */
      return page.items.map((edge) => edge.source.id);
    } catch {
      return [];
    }
  };

  const listThreads: ChatHomePort['listThreads'] = async (spaceId) => {
    lastSpaceId = spaceId;
    const [result, teammates] = await Promise.all([
      seam.query({ spaceId, kinds: ['chat'], sort: 'activityAt_desc', limit: 100 }),
      listTeammates(spaceId),
    ]);
    const labels = new Map(teammates.map((teammate) => [teammate.id, teammate.label]));
    const items = result.page.items
      /* `aboutId: null` — the LIST does not claim to know each chat's subject.
         See `aboutTargetOf` for the read this replaced. */
      .map((summary) => itemFromSummary(summary, null))
      .filter((item): item is ChatListItem => item !== null);
    for (const item of items) {
      listCache.set(item.chatId, item);
      listSpaceCache.set(item.chatId, spaceId);
    }
    return items.map<ChatThreadSummary>((item) => ({
      rootId: item.chatId,
      aboutId: item.aboutId,
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
        workdirMode: item.workdirMode,
        projectId: item.projectId,
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
    chatIdsAbout,
    listTeammates,
    listProjects,
    async readThread(chatId) {
      const item = await resolveItem(chatId);
      // FLAT (176 §1.3). Every message of a chat is anchored ON the chat with
      // no thread root, so this is one ordinary anchor read — no root detail to
      // fetch separately, and no `{ rootMessageId }` scope to pass. The
      // user->agent pairing that threading used to express lives in chat_turns.
      const [page, teammates, aboutId, provenance] = await Promise.all([
        seam.messages(chatId, { limit: 100 }),
        listTeammates(listSpaceCache.get(chatId) ?? lastSpaceId ?? ''),
        aboutTargetOf(chatId),
        provenanceOf(chatId),
      ]);
      const teammateLabel = teammates.find((teammate) => teammate.id === item.teammateId)?.label
        ?? 'Agent teammate';
      const messages = page.items;
      const turns = await Promise.all(
        messages.map(async (message) => ({
          messageId: message.id,
          /* THE CHAT'S OWN AGENT TURNS ARE NOT THIRD-PARTY. `createAgentMessage`
             posts them with `p_source_chat_id = the chat`, so their
             `authored_from` points here — dropping that case is what keeps the
             marker meaning "written from somewhere else". */
          ...(provenance.get(message.id) && provenance.get(message.id) !== chatId
            ? { sourceEntityId: provenance.get(message.id) as EntityId }
            : {}),
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
          aboutId,
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
            workdirMode: item.workdirMode,
            projectId: item.projectId,
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
          // The rail's project control (write-once, empty state only). A
          // composer that offers none still sends `scratch` explicitly.
          workdirMode: input.workdirMode ?? 'scratch',
          ...(input.workdirMode === 'project' && input.projectId ? { projectId: input.projectId } : {}),
          body: input.body,
          ...(input.title ? { title: input.title } : {}),
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
