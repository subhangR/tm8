/**
 * The strip's reads and verbs, bound to the seam by the host
 * (`ChatHomeSurface`). The screen never sees the seam; a host without one
 * passes nothing and the strip renders nothing.
 */
import type { DurableWorkspaceEvent, EntityId, EntitySummary, SpaceId } from '@tm8/contract';
import type { Seam } from '../../data/seam';

export interface CreatedHereReader {
  /** The roots made in `chatId` (any kind). Children come from `children`. */
  roots(input: { spaceId: SpaceId | string; chatId: EntityId }): Promise<readonly EntitySummary[]>;
  children(id: EntityId): Promise<readonly EntitySummary[]>;
  /** One summary, for ids the transcript says this chat created. */
  read?(id: EntityId): Promise<EntitySummary>;
  /** Durable entity events, for live rows. */
  subscribe?(listener: (event: DurableWorkspaceEvent) => void): () => void;
  /** Session verbs, hover-only. Absent ⇒ the action is not drawn. */
  stop?(sessionId: EntityId): Promise<void>;
  message?(sessionId: EntityId, body: string): Promise<void>;
  peek?(sessionId: EntityId): Promise<readonly { source: 'user' | 'assistant'; text: string }[]>;
}

const PAGE = 200;

function mutationId(verb: string, id: string): string {
  return `created-here:${verb}:${id}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * `filters.createdIn` (327) is the one read. A node that predates it refuses
 * the unknown filter (`invalid_input`, the schema is strict); there the strip
 * falls back to the sessions parented on the chat, and the screen unions the
 * transcript's own creates on top.
 */
export function createdHereReaderFromSeam(seam: Seam): CreatedHereReader {
  let legacy = false;
  return {
    async roots({ spaceId, chatId }) {
      const space = spaceId as SpaceId;
      if (!legacy) {
        try {
          const result = await seam.query({ spaceId: space, filters: { createdIn: chatId }, limit: PAGE });
          return result.page.items;
        } catch (error) {
          if (!isRefusedFilter(error)) throw error;
          legacy = true;
        }
      }
      /* Sessions only. The `authored_from` edge to a chat on such a node is
         every chat POST (hundreds of messages a page cannot see past), and the
         tasks and docs it made carry none — the strip adds those from the
         transcript's own creates instead. */
      const sessions = await seam.query({ spaceId: space, parentId: chatId, kinds: ['work_session'], limit: PAGE });
      return sessions.page.items;
    },
    async children(id) {
      const page = await seam.children(id, { limit: PAGE });
      return page.items;
    },
    read: (id) => seam.entity(id),
    subscribe: (listener) => seam.onEvent(listener),
    async stop(sessionId) {
      await seam.commands.terminate(sessionId, { clientMutationId: mutationId('stop', sessionId) });
    },
    async message(sessionId, body) {
      await seam.commands.postMessage({ clientMutationId: mutationId('message', sessionId), anchorIds: [sessionId], body });
    },
    async peek(sessionId) {
      const page = await seam.transcript(sessionId, { last: 6 });
      return page.available ? page.entries.map((entry) => ({ source: entry.source, text: entry.text })) : [];
    },
  };
}

function isRefusedFilter(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const status = (error as { status?: unknown } | null)?.status;
  return code === 'invalid_input' || status === 400;
}
