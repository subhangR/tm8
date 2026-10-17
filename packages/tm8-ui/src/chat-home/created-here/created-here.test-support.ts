import type { DurableWorkspaceEvent, EntityId, EntitySummary } from '@tm8/contract';
import type { CreatedHereReader } from './reader';

const SPACE = '019f0000-0000-7000-8000-000000000090';

/** A full-enough summary for the strip: kind, title, status and dates. */
export function madeSummary(partial: Partial<EntitySummary> & { id: string; kind: string }): EntitySummary {
  const { id, kind } = partial;
  const state = partial.state ?? (kind === 'task'
    ? { kind: 'task', status: 'open', priority: 'medium', axes: {}, assignees: [], acceptance: { total: 0, completed: 0 } }
    : kind === 'work_session'
      ? { kind: 'work_session', status: 'running', agentTool: 'claude-code', model: 'claude-opus-5', shareMode: 'space', startedAt: null, exitedAt: null }
      : { kind });
  return {
    spaceId: SPACE,
    title: `${kind} ${id.slice(-4)}`,
    parentId: null,
    position: 0,
    visibility: 'space',
    version: 1,
    activityAt: '2026-10-17T10:00:00.000Z',
    createdAt: '2026-10-17T10:00:00.000Z',
    updatedAt: '2026-10-17T10:00:00.000Z',
    deletedAt: null,
    createdBy: { id: '019f0000-0000-7000-8000-0000000000aa', kind: 'team_member', displayName: 'Dreamer', isAgent: true },
    counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
    badges: {},
    ...partial,
    state,
  } as unknown as EntitySummary;
}

export interface FakeReader extends CreatedHereReader {
  emit(event: DurableWorkspaceEvent): void;
  calls: { roots: number; children: string[]; stop: string[]; message: [string, string][] };
}

/** An in-memory reader: `roots` and `children` answer from the given maps. */
export function fakeCreatedHereReader(input: {
  roots?: readonly EntitySummary[];
  children?: Record<string, readonly EntitySummary[]>;
  reads?: readonly EntitySummary[];
}): FakeReader {
  const listeners = new Set<(event: DurableWorkspaceEvent) => void>();
  const calls: FakeReader['calls'] = { roots: 0, children: [], stop: [], message: [] };
  const reads = new Map((input.reads ?? []).map((item) => [item.id, item]));
  return {
    calls,
    async roots() {
      calls.roots += 1;
      return input.roots ?? [];
    },
    async children(id: EntityId) {
      calls.children.push(id);
      return input.children?.[id] ?? [];
    },
    async read(id: EntityId) {
      const item = reads.get(id);
      if (!item) throw new Error(`no read for ${id}`);
      return item;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async stop(id) {
      calls.stop.push(id);
    },
    async message(id, body) {
      calls.message.push([id, body]);
    },
    async peek() {
      return [{ source: 'assistant' as const, text: 'Running the focused tests now.' }];
    },
    emit(event) {
      for (const listener of listeners) listener(event);
    },
  };
}
