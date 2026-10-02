/**
 * The story page's spawn door: StoryAddRequest (spawn | dispatch |
 * coordinator) onto the EXISTING launch commands — `execution.spawn` and
 * `execution.dispatch`, exactly as `useLaunchPort` sends them. No new op.
 *
 * The subject is `onId`: the story, a root, or a task. A launch on a story
 * runs on the task the server derives from it, and the server puts that task
 * in the story as a root (spawn-on-story, `spawn-story.ts`), so the session
 * shows up in the story through its `working_on` edge with no write here.
 * A live session as `onId` means "under that session": the launch runs on
 * the session's first task in the story (else the story), and a coordinated
 * mode reports to it as its parent.
 *
 * Spawn needs a teammate to run as (`asTeammateId`); the page offers
 * teammates, and making a new one is not a launch. Dispatch names none — the
 * space's dispatcher chooses — and answers with the request's task, not a
 * session (the dispatcher decides later).
 */
import type { EntityId, ExecutionSpawnInput, SpaceId } from '@tm8/contract';
import type { Seam } from '../../data/seam';
import { uuidV7 } from '../../channel-screen/chat-mutations';
import type { StoryAddRequest } from '../actions';
import type { StoryView } from '../model';

export interface StorySpawned {
  id: EntityId;
  kind: string;
  title: string;
}

export interface StorySpawnContext {
  storyId: EntityId;
  spaceId: () => Promise<SpaceId>;
  view: () => Promise<StoryView | null>;
}

const SESSION_KIND = 'work_session';
const TASK_KIND = 'task';
const TITLE_MAX = 80;

/** A launch title from the words the person typed: first line, bounded. */
export function launchTitle(text: string): string {
  const line = text.trim().split('\n')[0]!.trim();
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

/** The subject a launch runs on: a session resolves to its task, else the story. */
export function launchSubject(view: StoryView | null, storyId: EntityId, onId: EntityId): EntityId {
  const session = view?.page.sessions.find((s) => s.id === onId);
  if (!session) return onId;
  return (session.taskIds[0] as EntityId | undefined) ?? storyId;
}

/**
 * A coordinator launched UNDER a session reports to it
 * (`coordinated-coordinator` + `parentSessionId`); one launched on the story or
 * a task by a person has nobody to report to, and the server refuses
 * `coordinated-coordinator` without a parent — so it is a top-level
 * `coordinator`. `spawn` takes the requested mode, else the teammate's default.
 */
export function spawnMode(req: StoryAddRequest, parentSessionId: EntityId | null): ExecutionSpawnInput['mode'] | undefined {
  if (req.intent === 'coordinator') return parentSessionId ? 'coordinated-coordinator' : 'coordinator';
  return req.mode ?? undefined;
}

export function createStorySpawn(seam: Seam, ctx: StorySpawnContext): (req: StoryAddRequest) => Promise<StorySpawned> {
  return async (req) => {
    const text = req.text.trim();
    const [spaceId, view] = await Promise.all([ctx.spaceId(), ctx.view()]);
    const subjectId = launchSubject(view, ctx.storyId, req.onId as EntityId);
    const onSession = view?.page.sessions.some((s) => s.id === req.onId) ? (req.onId as EntityId) : null;

    if (req.intent === 'dispatch') {
      const result = await seam.commands.dispatch({
        clientMutationId: uuidV7(),
        spaceId,
        subjectId,
        ...(text ? { note: text } : {}),
      });
      return { id: result.taskId, kind: TASK_KIND, title: text ? launchTitle(text) : 'Dispatched work' };
    }

    if (!req.asTeammateId) throw new Error('Pick a teammate to run it.');
    const mode = spawnMode(req, onSession);
    // Only a coordinated mode reports to the session it was launched on.
    const parentSessionId = mode === 'coordinated-coordinator' || mode === 'coordinated-worker' ? onSession : null;
    const result = await seam.commands.spawn({
      clientMutationId: uuidV7(),
      spaceId,
      teamMemberId: req.asTeammateId as EntityId,
      taskIds: [subjectId],
      ...(mode ? { mode } : {}),
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(text ? { title: launchTitle(text), promptExtra: text } : {}),
    });
    const session = result.entity;
    if (!session) throw new Error('The server did not return the session it started.');
    return { id: session.id, kind: SESSION_KIND, title: session.title };
  };
}
