/**
 * Builders for Ask Jev tests: contract-shaped answers and a port whose every
 * request stays pending until the test settles it, so ordering is the test's.
 */
import type {
  EntitySuggestion,
  JevCost,
  JevFailure,
  JevGroupResult,
  LaunchSuggestInput,
  LaunchSuggestResult,
  ModelSuggestion,
  RankedEntity,
  RankedEntitySource,
  TeammateSuggestion,
} from '@tm8/contract';

import type { JevPort } from './port';

export const cost = (calls: number, usd = 0.00004, latencyMs = 400): JevCost => ({
  calls, inputTokens: 900 * calls, outputTokens: 0, usd, latencyMs,
});

export function item(
  entityId: string,
  kind: RankedEntity['kind'],
  score: number,
  suggested: boolean,
  sources: RankedEntitySource[] = ['space'],
  title = `${kind} ${entityId}`,
  promptBytes = 300,
): RankedEntity {
  const r = Math.round(score);
  const level = r >= 3 ? 'critical' : r === 2 ? 'useful' : r === 1 ? 'background' : 'irrelevant';
  return {
    entityId, kind, title, sources, score, level, suggested,
    default: sources.includes('teammate') || sources.includes('inherited') || sources.includes('task'),
    promptBytes,
    header: { whenToUse: null, summary: title, keywords: [], source: 'derived', version: 0 },
    ...(suggested ? {} : { reason: score < 1.5 ? 'below-floor' as const : 'over-budget' as const }),
  };
}

export const MODEL: ModelSuggestion = {
  tier: 'standard', model: 'claude-sonnet-5', agentTool: 'claude-code', effort: 'high',
  need: 1.2, workKind: 'feature', reasons: ['Moderate depth.', 'One package.'],
};

export const TEAMMATES: TeammateSuggestion = {
  items: [
    item('ent-tm-scout', 'team_member', 2.6, true, ['space'], 'scout'),
    item('ent-tm-forge', 'team_member', 1.4, true, ['space'], 'forge'),
  ],
  noFit: false,
  floor: 1,
};

/** Three memories, two suggested; the first is critical and from two sources. */
export const MEMORIES: EntitySuggestion = {
  items: [
    item('mem-a', 'memory', 2.8, true, ['teammate', 'space'], 'Invite links are single-use'),
    item('mem-b', 'memory', 1.9, true, ['task']),
    item('mem-c', 'memory', 0.3, false, ['space']),
  ],
  considered: 3,
  total: 3,
  budget: 12288,
  floor: 1.5,
};

export const SKILLS: EntitySuggestion = {
  items: [
    item('sk-a', 'skill', 2.1, true, ['teammate']),
    item('sk-b', 'skill', 0.8, false, ['inherited', 'space']),
  ],
  considered: 2,
  total: 812,
  budget: null,
  floor: 1.5,
};

/**
 * References: a default the fill ticked (ref-a), a pick that isn't a default
 * (ref-b), and a DEFAULT above the floor that the budget left out (ref-c,
 * `over-budget`) — the row a person must see as unticked with its reason.
 * Budget 1000 with the frame: 400 + 350 + frame fits, 600 more does not.
 */
export const REFERENCES: EntitySuggestion = {
  items: [
    item('ref-a', 'doc', 2.7, true, ['task'], 'Join-screen spec', 400),
    item('ref-b', 'artifact', 2.2, true, ['space'], 'Invite flow mock', 350),
    item('ref-c', 'task', 2.0, false, ['task'], 'Parent epic', 600),
    item('ref-d', 'file', 0.4, false, ['space'], 'old.log', 90),
  ],
  considered: 4,
  total: 4,
  budget: 1000,
  floor: 1.5,
};

/**
 * Memories whose budget BINDS: mem-x is a default above the floor left out
 * `over-budget`; mem-y (not a default) is ticked.
 */
export const BOUND_MEMORIES: EntitySuggestion = {
  items: [
    item('mem-a', 'memory', 2.8, true, ['teammate'], 'Invite links are single-use', 500),
    item('mem-x', 'memory', 2.4, false, ['inherited'], 'Huge style guide', 4000),
    item('mem-y', 'memory', 2.0, true, ['space'], 'Links expire in 24h', 300),
  ],
  considered: 3,
  total: 3,
  budget: 1000,
  floor: 1.5,
};

/** The index-off answer for references: no prompt bytes, no budget. */
export const REFERENCES_OFF: EntitySuggestion = {
  ...REFERENCES,
  items: REFERENCES.items.map((row) => ({ ...row, promptBytes: 0 })),
  budget: null,
};

export const okGroup = <T,>(value: T, c = cost(1)): JevGroupResult<T> => ({ status: 'ok', value, cost: c });
export const failedGroup = (reason: JevFailure, c = cost(1)): JevGroupResult<never> => ({ status: 'failed', reason, cost: c });

/** A full answer for whatever groups the input asked for. */
export function answer(
  input: LaunchSuggestInput,
  over: Partial<LaunchSuggestResult['groups']> = {},
  run: JevCost = cost(7, 0.00021, 1100),
  contextIndex: 'on' | 'off' = 'on',
): LaunchSuggestResult {
  const all: LaunchSuggestResult['groups'] = {
    model: okGroup(MODEL),
    teammates: okGroup(TEAMMATES),
    memories: okGroup(MEMORIES, cost(1, 0.00004, 400)),
    skills: okGroup(SKILLS),
    references: okGroup(REFERENCES),
    ...over,
  };
  const groups: LaunchSuggestResult['groups'] = {};
  for (const g of input.groups) (groups as Record<string, unknown>)[g] = all[g];
  return { runId: input.runId, groups, contextIndex, run };
}

export interface PendingCall {
  input: LaunchSuggestInput;
  resolve(result: LaunchSuggestResult): void;
  reject(error: unknown): void;
}

/** Every request stays pending until the test settles it. */
export function pendingPort(): JevPort & { calls: PendingCall[] } {
  const calls: PendingCall[] = [];
  return {
    calls,
    suggest(_spaceId, input) {
      return new Promise((resolve, reject) => { calls.push({ input, resolve, reject }); });
    },
  };
}

/** Answers every request at once with `answer(input, over)`. */
export function answeringPort(
  over: Partial<LaunchSuggestResult['groups']> = {},
): JevPort & { inputs: LaunchSuggestInput[] } {
  const inputs: LaunchSuggestInput[] = [];
  return {
    inputs,
    suggest(_spaceId, input) {
      inputs.push(input);
      return Promise.resolve(answer(input, over));
    },
  };
}
