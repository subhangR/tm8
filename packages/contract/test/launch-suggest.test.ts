// The Jev Launch Advisor contract (design 01a0cb80 §5), frozen by lane F.
//
// Three lanes code against these shapes, so the tests pin the RULES rather
// than restate the fields: strictness, a non-empty unique `groups`, the spawn
// `selection` bounds, and the one-meaning rule that refuses `selection`
// together with `memoryIds`.

import { describe, expect, it } from 'vitest';
import {
  ExecutionSpawnInputSchema,
  LaunchSuggestInputSchema,
  LaunchSuggestResultSchema,
  OPERATIONS,
  SPAWN_SELECTION_EMPTY_MESSAGE,
  SPAWN_SELECTION_GROUP_LIMIT,
  SPAWN_SELECTION_WITH_MEMORY_IDS_MESSAGE,
  type LaunchSuggestResult,
} from '../src/index.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const suggest = {
  runId: uuid(1),
  requestId: uuid(2),
  subjectId: uuid(3),
  groups: ['model', 'teammates', 'memories', 'skills'],
};

const spawn = {
  clientMutationId: 'cmid-spawn-1',
  spaceId: uuid(10),
  teamMemberId: uuid(11),
};

describe('launch.suggest catalog row', () => {
  it('is a v1 POST command under the space', () => {
    expect(OPERATIONS.find((op) => op.name === 'launch.suggest')).toEqual({
      name: 'launch.suggest',
      method: 'POST',
      path: '/v2/spaces/:spaceId/launch/suggest',
      kind: 'command',
      status: 'v1',
    });
  });
});

describe('LaunchSuggestInputSchema', () => {
  it('accepts the minimal body and every optional field', () => {
    expect(LaunchSuggestInputSchema.safeParse(suggest).success).toBe(true);
    expect(LaunchSuggestInputSchema.safeParse({
      ...suggest,
      draft: { title: 'Fix the deploy target', description: 'deploy.sh points at 7777.' },
      teamMemberId: uuid(4),
    }).success).toBe(true);
  });

  it('accepts the clientMutationId the facade injects when the command ledger is off', () => {
    expect(LaunchSuggestInputSchema.safeParse({ ...suggest, clientMutationId: 'injected' }).success).toBe(true);
  });

  it('is strict: an unknown key is refused, not ignored', () => {
    expect(LaunchSuggestInputSchema.safeParse({ ...suggest, model: 'opus' }).success).toBe(false);
    expect(LaunchSuggestInputSchema.safeParse({
      ...suggest,
      draft: { title: 't', description: 'd', priority: 'high' },
    }).success).toBe(false);
  });

  it('requires a non-empty groups array', () => {
    expect(LaunchSuggestInputSchema.safeParse({ ...suggest, groups: [] }).success).toBe(false);
    const { groups: _groups, ...noGroups } = suggest;
    expect(LaunchSuggestInputSchema.safeParse(noGroups).success).toBe(false);
  });

  it('refuses a repeated group, which would ask and bill Jev twice', () => {
    const parsed = LaunchSuggestInputSchema.safeParse({ ...suggest, groups: ['skills', 'skills'] });
    expect(parsed.success).toBe(false);
  });

  it('refuses an unknown group and non-uuid ids', () => {
    expect(LaunchSuggestInputSchema.safeParse({ ...suggest, groups: ['persona'] }).success).toBe(false);
    expect(LaunchSuggestInputSchema.safeParse({ ...suggest, runId: 'run-1' }).success).toBe(false);
    expect(LaunchSuggestInputSchema.safeParse({ ...suggest, teamMemberId: 'tm-1' }).success).toBe(false);
  });
});

describe('LaunchSuggestResultSchema', () => {
  const cost = { calls: 1, inputTokens: 1200, outputTokens: 40, usd: 0.0000504, latencyMs: 380 };
  const result: LaunchSuggestResult = {
    runId: uuid(1),
    groups: {
      model: {
        status: 'ok',
        value: {
          tier: 'standard', model: 'claude-sonnet-5', agentTool: 'claude-code', effort: 'high',
          need: 0.55, workKind: 'feature', reasons: ['multi-file change'],
        },
        cost,
      },
      teammates: { status: 'failed', reason: 'timeout', cost },
      memories: {
        status: 'ok',
        value: {
          items: [{
            entityId: uuid(20), kind: 'memory', title: 'Deploy box is prod',
            sources: ['teammate', 'task'], score: 2.6, level: 'critical', suggested: true,
          }],
          considered: 1,
          total: 1,
        },
        cost,
      },
      skills: { status: 'skipped', reason: 'no_teammate', cost: { ...cost, calls: 0, inputTokens: 0, outputTokens: 0, usd: 0, latencyMs: 0 } },
    },
    run: { ...cost, calls: 3 },
  };

  it('accepts every group status', () => {
    const parsed = LaunchSuggestResultSchema.safeParse(result);
    expect(parsed.success, JSON.stringify(parsed.success ? {} : parsed.error.issues)).toBe(true);
  });

  it('refuses a failure reason outside the JevFailure vocabulary', () => {
    expect(LaunchSuggestResultSchema.safeParse({
      ...result,
      groups: { ...result.groups, teammates: { status: 'failed', reason: 'boom', cost } },
    }).success).toBe(false);
  });

  it('keeps a ranked score on the 0..3 scale', () => {
    const memories = result.groups.memories;
    if (memories?.status !== 'ok') throw new Error('fixture');
    const item = { ...memories.value.items[0]!, score: 3.5 };
    expect(LaunchSuggestResultSchema.safeParse({
      ...result,
      groups: { ...result.groups, memories: { ...memories, value: { ...memories.value, items: [item] } } },
    }).success).toBe(false);
  });
});

describe('ExecutionSpawnInputSchema — selection and jevRunId', () => {
  const selection = { memoryIds: [uuid(30)], skillIds: [uuid(31), uuid(32)] };

  it('accepts selection and jevRunId, and a launch with neither', () => {
    expect(ExecutionSpawnInputSchema.safeParse(spawn).success).toBe(true);
    expect(ExecutionSpawnInputSchema.safeParse({ ...spawn, selection, jevRunId: uuid(1) }).success).toBe(true);
    // An empty selection is a real choice: launch with no memories and no skills.
    expect(ExecutionSpawnInputSchema.safeParse({
      ...spawn, selection: { memoryIds: [], skillIds: [] },
    }).success).toBe(true);
  });

  it('refuses selection together with memoryIds, and says why in words', () => {
    const parsed = ExecutionSpawnInputSchema.safeParse({ ...spawn, selection, memoryIds: [uuid(33)] });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.message)).toContain(SPAWN_SELECTION_WITH_MEMORY_IDS_MESSAGE);
    expect(SPAWN_SELECTION_WITH_MEMORY_IDS_MESSAGE).toMatch(/selection and memoryIds cannot be combined/);
    // Even an empty memoryIds is a second meaning for the same field.
    expect(ExecutionSpawnInputSchema.safeParse({ ...spawn, selection, memoryIds: [] }).success).toBe(false);
    // memoryIds alone is still the additive hand-off it always was.
    expect(ExecutionSpawnInputSchema.safeParse({ ...spawn, memoryIds: [uuid(33)] }).success).toBe(true);
  });

  it('bounds every group at one ceiling, SPAWN_SELECTION_GROUP_LIMIT (240)', () => {
    expect(SPAWN_SELECTION_GROUP_LIMIT).toBe(240);
    const ids = (n: number, from: number) => Array.from({ length: n }, (_v, i) => uuid(from + i));
    const max = SPAWN_SELECTION_GROUP_LIMIT;
    expect(ExecutionSpawnInputSchema.safeParse({
      ...spawn, selection: { memoryIds: ids(max, 1000), skillIds: ids(max, 2000), referenceIds: ids(max, 3000) },
    }).success).toBe(true);
    for (const group of ['memoryIds', 'skillIds', 'referenceIds']) {
      expect(ExecutionSpawnInputSchema.safeParse({
        ...spawn, selection: { [group]: ids(max + 1, 1000) },
      }).success, group).toBe(false);
    }
  });

  it('makes every group optional, but refuses a selection naming none', () => {
    for (const only of [{ memoryIds: [] }, { skillIds: [uuid(3)] }, { referenceIds: [uuid(4)] }]) {
      expect(ExecutionSpawnInputSchema.safeParse({ ...spawn, selection: only }).success, JSON.stringify(only)).toBe(true);
    }
    const empty = ExecutionSpawnInputSchema.safeParse({ ...spawn, selection: {} });
    expect(empty.success).toBe(false);
    expect(JSON.stringify(empty.error?.issues)).toContain(SPAWN_SELECTION_EMPTY_MESSAGE);
  });

  it('is strict inside selection and wants uuids', () => {
    expect(ExecutionSpawnInputSchema.safeParse({
      ...spawn, selection: { ...selection, teammateIds: [] },
    }).success).toBe(false);
    expect(ExecutionSpawnInputSchema.safeParse({
      ...spawn, selection: { memoryIds: ['m0'], skillIds: [] },
    }).success).toBe(false);
    expect(ExecutionSpawnInputSchema.safeParse({
      ...spawn, selection: { referenceIds: ['doc-1'] },
    }).success).toBe(false);
    expect(ExecutionSpawnInputSchema.safeParse({ ...spawn, jevRunId: 'run-1' }).success).toBe(false);
  });

  it('keeps refusing selection together with the additive memoryIds, whichever groups it names', () => {
    const r = ExecutionSpawnInputSchema.safeParse({ ...spawn, memoryIds: [uuid(1)], selection: { skillIds: [] } });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain(SPAWN_SELECTION_WITH_MEMORY_IDS_MESSAGE);
  });

  it('takes a closed, per-group selectionReasons enum, only for groups the selection omits', () => {
    expect(ExecutionSpawnInputSchema.safeParse({
      ...spawn, selectionReasons: { memories: 'cli', skills: 'cli', references: 'cli' },
    }).success).toBe(true);
    expect(ExecutionSpawnInputSchema.safeParse({
      ...spawn, selection: { memoryIds: [] }, selectionReasons: { skills: 'jev-failed', references: 'jev-pending' },
    }).success).toBe(true);
    expect(ExecutionSpawnInputSchema.safeParse({ ...spawn, selectionReasons: { memories: 'because' } }).success).toBe(false);
    expect(ExecutionSpawnInputSchema.safeParse({ ...spawn, selectionReasons: { teammates: 'cli' } }).success).toBe(false);
    const both = ExecutionSpawnInputSchema.safeParse({
      ...spawn, selection: { skillIds: [] }, selectionReasons: { skills: 'not-asked' },
    });
    expect(both.success).toBe(false);
    expect(JSON.stringify(both.error?.issues)).toContain('selectionReasons.skills');
  });
});
