import type { ActorSummary, EntityId, SpaceId } from '@tm8/contract';
import { CollabError } from '@tm8/contract';
import type { LoopDefinition, LoopRun, LoopSchedulePreview, LoopsClient, LoopView } from './api';

/*
 * THE FIXTURE SEAM'S LOOPS CLIENT — an in-memory store with the server's
 * shapes, for the fixture app and tests. It does NOT model scheduling: a
 * preview answers a canned summary with no next instants and `nextRunAt`
 * stays whatever the seed says, so nothing here becomes a second schedule
 * grammar. Tests that care about preview content stub `schedulePreview`.
 */

const FIXTURE_ACTOR: ActorSummary = { id: 'fixture-member', kind: 'member', displayName: 'Fixture member', isAgent: false };

export function fixtureLoopView(id: EntityId, spaceId: SpaceId, definition: Partial<LoopDefinition> = {}, overrides: Partial<LoopView> = {}): LoopView {
  const now = new Date(0).toISOString();
  const full: LoopDefinition = {
    title: 'Fixture loop', schedule: 'every 1d', timezone: 'UTC', action: 'dispatch',
    teamMemberId: null, subjectId: null, toolId: null, toolInputs: {}, prompt: '',
    config: {}, concurrency: 'skip', maxRuntimeSeconds: null, retry: { attempts: 0, delaySeconds: 60 },
    ...definition,
  };
  return {
    id, spaceId, version: 1, definition: full,
    schedule: { valid: true, problem: null, summary: `Schedule ${full.schedule} (${full.timezone})`, next: [] },
    state: {
      enabled: true, pausedUntil: null, nextRunAt: null, lastRunAt: null, lastError: null,
      armedBy: FIXTURE_ACTOR, armedAt: now, actingAs: { identity: FIXTURE_ACTOR, via: 'armer' }, waitingOnRunId: null,
    },
    runs: { total: 0, last: null, last24h: { fired: 0, failed: 0, skipped: 0 }, usage: { inputTokens: null, outputTokens: null, costUsd: null } },
    createdBy: FIXTURE_ACTOR, createdAt: now, updatedAt: now,
    capabilities: { canEdit: true, canControl: true, canRun: true, canDelete: true },
    ...overrides,
  };
}

export function createFixtureLoopsClient(seed: readonly LoopView[] = []): LoopsClient & { readonly loops: Map<string, LoopView> } {
  const loops = new Map(seed.map(loop => [loop.id, loop]));
  const runs = new Map<string, LoopRun>();
  const find = (id: string) => {
    const loop = loops.get(id);
    if (!loop) throw new CollabError('not_found', `loop ${id} not found`);
    return loop;
  };
  const write = (ref: Pick<LoopView, 'id' | 'version'>, change: (loop: LoopView) => LoopView) => {
    const loop = find(ref.id);
    if (loop.version !== ref.version) throw new CollabError('version_conflict', 'The loop changed since it was read.');
    const next = { ...change(loop), version: loop.version + 1 };
    loops.set(next.id, next);
    return Promise.resolve(next);
  };
  const preview = (schedule: string, timezone = 'UTC'): LoopSchedulePreview => schedule.trim() === ''
    ? { valid: false, problem: 'schedule is required', summary: '', next: [] }
    : { valid: true, problem: null, summary: `Schedule ${schedule.trim()} (${timezone})`, next: [] };
  return {
    loops,
    async create(spaceId, definition, enabled = true) {
      const id = crypto.randomUUID();
      const view = fixtureLoopView(id, spaceId, definition);
      view.state.enabled = enabled;
      view.schedule = preview(view.definition.schedule, view.definition.timezone);
      loops.set(id, view);
      return view;
    },
    update: (ref, definition) => write(ref, loop => {
      const merged = { ...loop.definition, ...definition };
      return { ...loop, definition: merged, schedule: preview(merged.schedule, merged.timezone) };
    }),
    get: async loopId => find(loopId),
    list: async (spaceId, query = {}) => ({
      items: [...loops.values()].filter(loop => loop.spaceId === spaceId
        && (query.enabled === undefined || loop.state.enabled === query.enabled)
        && (query.action === undefined || loop.definition.action === query.action)),
      nextCursor: null,
    }),
    enable: ref => write(ref, loop => ({ ...loop, state: { ...loop.state, enabled: true } })),
    disable: ref => write(ref, loop => ({ ...loop, state: { ...loop.state, enabled: false } })),
    pause: (ref, until) => write(ref, loop => ({ ...loop, state: { ...loop.state, pausedUntil: until } })),
    resume: ref => write(ref, loop => ({ ...loop, state: { ...loop.state, pausedUntil: null } })),
    async runNow(loopId) {
      const loop = find(loopId);
      const run: LoopRun = {
        id: crypto.randomUUID(), loopId, spaceId: loop.spaceId, firedAt: new Date().toISOString(),
        trigger: 'manual', requestedBy: FIXTURE_ACTOR, action: loop.definition.action, attempt: 0,
        status: 'running', skipReason: null, error: null, taskId: null, sessionId: null,
        startedAt: null, endedAt: null, durationMs: null, exitCode: null, outputTail: null,
        actedAs: FIXTURE_ACTOR, endedKind: null, usage: null,
      };
      runs.set(run.id, run);
      return { run };
    },
    runsList: async loopId => ({ items: [...runs.values()].filter(run => run.loopId === loopId), nextCursor: null }),
    async runsGet(runId) {
      const run = runs.get(runId);
      if (!run) throw new CollabError('not_found', `run ${runId} not found`);
      return run;
    },
    async runsStop(runId) {
      const run = runs.get(runId);
      if (!run) throw new CollabError('not_found', `run ${runId} not found`);
      const stopped: LoopRun = { ...run, status: 'stopped', endedAt: new Date().toISOString() };
      runs.set(runId, stopped);
      return { run: stopped };
    },
    schedulePreview: async (_spaceId, schedule, timezone) => preview(schedule, timezone),
  };
}
