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
): RankedEntity {
  const r = Math.round(score);
  const level = r >= 3 ? 'critical' : r === 2 ? 'useful' : r === 1 ? 'background' : 'irrelevant';
  return { entityId, kind, title, sources, score, level, suggested };
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
};

export const SKILLS: EntitySuggestion = {
  items: [
    item('sk-a', 'skill', 2.1, true, ['teammate']),
    item('sk-b', 'skill', 0.8, false, ['inherited', 'space']),
  ],
  considered: 2,
  total: 812,
};

export const okGroup = <T,>(value: T, c = cost(1)): JevGroupResult<T> => ({ status: 'ok', value, cost: c });
export const failedGroup = (reason: JevFailure, c = cost(1)): JevGroupResult<never> => ({ status: 'failed', reason, cost: c });

/** A full answer for whatever groups the input asked for. */
export function answer(
  input: LaunchSuggestInput,
  over: Partial<LaunchSuggestResult['groups']> = {},
  run: JevCost = cost(7, 0.00021, 1100),
): LaunchSuggestResult {
  const all: LaunchSuggestResult['groups'] = {
    model: okGroup(MODEL),
    teammates: okGroup(TEAMMATES),
    memories: okGroup(MEMORIES, cost(1, 0.00004, 400)),
    skills: okGroup(SKILLS),
    ...over,
  };
  const groups: LaunchSuggestResult['groups'] = {};
  for (const g of input.groups) (groups as Record<string, unknown>)[g] = all[g];
  return { runId: input.runId, groups, run };
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
