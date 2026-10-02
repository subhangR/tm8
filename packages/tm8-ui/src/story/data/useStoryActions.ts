/**
 * The story page's `StoryActions` (actions.ts), wired to the real ops.
 *
 *   const actions = useStoryActions(seam, storyId, { view, open, spawn });
 *
 * Every member reads what it needs (space, version) itself, so the host can
 * pass `view` or not. Writes reject with the server's own message; the page
 * shows it as-is. No member updates the page itself — the event each write
 * emits does that, through `useStoryLive`.
 *
 * Roots ride `collections.addItem|removeItem` with the story as container
 * (282 accepts a story there), i.e. live `contains` edges with a position.
 *
 * Spawn / dispatch / coordinator ride `story-spawn.ts` (execution.spawn /
 * execution.dispatch); a host may pass its own `spawn` instead.
 */
import { useMemo, useRef } from 'react';
import type { CommandResult, EntityId, MessageBatchResult, SpaceId } from '@tm8/contract';
import type { Seam } from '../../data/seam';
import { uuidV7 } from '../../channel-screen/chat-mutations';
import type { StoryActions, StoryAddRequest } from '../actions';
import type { StoryView } from '../model';
import { resolveTellTargets, tellAbout, type TellResult } from './tell';
import { toStoryView } from './toStoryView';
import { createStorySpawn, type StorySpawned } from './story-spawn';

export type { StorySpawned };


export interface UseStoryActionsOptions {
  /** The live view, when the host has it (saves a read for tell targets). */
  view?: StoryView | null;
  /** Navigate to an entity. Absent = no open affordance. */
  open?: (entityId: EntityId) => void;
  /** Spawn-on-story: spawn / dispatch / coordinator intents. Default: `createStorySpawn` (execution.spawn / execution.dispatch). */
  spawn?: (req: StoryAddRequest) => Promise<StorySpawned>;
  /** Tell outcomes, per target (failures never undo the create). */
  onTold?: (results: TellResult[]) => void;
}

/** The kind with a completion door of its own (`tasks.complete`). */
const TASK_KIND = 'task';
const STORY_KIND = 'story';
/** The membership picker's page size (views/membershipSurface.ts). */
const ROOT_SEARCH_LIMIT = 50;

function createdId(result: CommandResult): EntityId {
  const id = result.entity?.id;
  if (!id) throw new Error('The server did not return what it created.');
  return id;
}

function postedId(result: CommandResult | MessageBatchResult): string | undefined {
  return 'messages' in result ? result.messages[0]?.id : result.entity?.id;
}

export function createStoryActions(seam: Seam, storyId: EntityId, opts: UseStoryActionsOptions = {}): StoryActions {
  let spaceId: SpaceId | null = null;
  const space = async (): Promise<SpaceId> => {
    if (!spaceId) spaceId = (await seam.entity(storyId)).spaceId;
    return spaceId;
  };
  const ctx = () => ({ clientMutationId: uuidV7() });

  const currentView = async (): Promise<StoryView | null> =>
    opts.view ?? toStoryView({ entity: await seam.entity(storyId) });

  const spawn = opts.spawn ?? createStorySpawn(seam, { storyId, spaceId: space, view: currentView });

  const tell = async (made: StorySpawned, tellIds: readonly string[]): Promise<void> => {
    if (tellIds.length === 0) return;
    const view = await currentView();
    const results = await tellAbout(seam, {
      newEntity: { ...made, spaceId: await space() },
      targets: resolveTellTargets(view, tellIds),
      story: view ? { id: view.id, title: view.title } : null,
    });
    opts.onTold?.(results);
  };

  const createTask = async (parentId: EntityId, title: string): Promise<EntityId> => {
    const sid = await space();
    if (parentId !== storyId) {
      return createdId(await seam.commands.createTask({ ...ctx(), spaceId: sid, title, parentId }));
    }
    // "+ task" on the story itself: a new task that is a root.
    const id = createdId(await seam.commands.createTask({ ...ctx(), spaceId: sid, title }));
    await seam.commands.addToCollection(storyId, { ...ctx(), entityId: id });
    return id;
  };

  const actions: StoryActions = {
    async add(req) {
      const text = req.text.trim();
      if (!text) throw new Error('Say what it is first.');
      switch (req.intent) {
        case 'task': {
          const id = await createTask(req.onId, text);
          await tell({ id, kind: TASK_KIND, title: text }, req.tellIds);
          return id;
        }
        case 'child-story': {
          const result = await seam.commands.createEntity({
            ...ctx(), spaceId: await space(), kind: STORY_KIND, title: text, parentId: storyId,
            content: { kind: STORY_KIND },
          });
          const id = createdId(result);
          await tell({ id, kind: STORY_KIND, title: text }, req.tellIds);
          return id;
        }
        case 'message': {
          const result = await seam.commands.postMessage({ ...ctx(), anchorIds: [req.onId], body: text });
          return postedId(result);
        }
        case 'spawn':
        case 'dispatch':
        case 'coordinator': {
          const made = await spawn(req);
          await tell(made, req.tellIds);
          return made.id;
        }
      }
    },
    createTask,
    async rename(entityId, title) {
      const current = await seam.entity(entityId);
      await seam.commands.patchEntity(entityId, { ...ctx(), expectedVersion: current.version, title });
    },
    async markDone(entityId) {
      const current = await seam.entity(entityId);
      if (current.kind === TASK_KIND) {
        // No completer: completes and credits nobody (useRowLifecycle's rule).
        await seam.commands.complete(entityId, { ...ctx(), expectedVersion: current.version, completerIds: [] });
      } else {
        await seam.commands.work(entityId, { ...ctx(), status: 'done' });
      }
    },
    async sendMessage(anchorId, body) {
      return postedId(await seam.commands.postMessage({ ...ctx(), anchorIds: [anchorId], body }));
    },
    async addRoot(entityId) {
      await seam.commands.addToCollection(storyId, { ...ctx(), entityId });
    },
    async removeRoot(entityId) {
      await seam.commands.removeFromCollection(storyId, entityId, ctx());
    },
    /* The membership picker's search (views/membershipSurface.ts), not a new
       query: one bounded recent page of `collections.query` — `search.query`
       is reserved, so there is no server text search — filtered by title
       here the way MembershipBlock filters it. The story never offers itself. */
    async searchRoots(text) {
      const result = await seam.query({ spaceId: await space(), limit: ROOT_SEARCH_LIMIT });
      const words = text.toLowerCase().split(/\s+/).filter(Boolean);
      return result.page.items.filter((e) => {
        if (e.id === storyId) return false;
        const title = e.title.toLowerCase();
        return words.every((w) => title.includes(w));
      });
    },
    async setStatus(status) {
      // The kind's own state field; the seam types it as WorkStatus (useRowLifecycle).
      await seam.commands.work(storyId, { ...ctx(), status: status as never });
    },
  };
  if (opts.open) actions.open = opts.open;
  return actions;
}

export function useStoryActions(seam: Seam, storyId: EntityId, opts: UseStoryActionsOptions = {}): StoryActions {
  // The view changes on every live tick; read it through a ref so the actions
  // object (and every block memoised on it) stays the same.
  const latest = useRef(opts);
  latest.current = opts;
  const hasOpen = !!opts.open;
  const hasSpawn = !!opts.spawn;
  return useMemo(() => {
    const port: UseStoryActionsOptions = {
      get view() { return latest.current.view; },
      ...(hasSpawn ? { spawn: (req: StoryAddRequest) => latest.current.spawn!(req) } : {}),
      onTold: (results) => latest.current.onTold?.(results),
      ...(hasOpen ? { open: (id: EntityId) => latest.current.open?.(id) } : {}),
    };
    return createStoryActions(seam, storyId, port);
  }, [seam, storyId, hasOpen, hasSpawn]);
}
