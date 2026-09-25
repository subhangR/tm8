/**
 * THE PER-LAUNCH BUDGET OVERRIDE (design 01a0d348 §10 Q5.4, I7).
 *
 * `buildSpawnInput` sends `contextBudgets` only with the keys a person set,
 * and every input it builds is one the node's `ExecutionSpawnInputSchema`
 * accepts. The sheet's ceiling warning is a call of the node's
 * `contextBudgetOverrun`; these cases pin that it agrees with the node's check
 * for every override the sheet can send, and says nothing for none.
 */
import { describe, expect, it } from 'vitest';
import { BYTE_BUDGETS, contextBudgetBaseline, contextBudgetOverrun } from '@tm8/prompt';
import { ExecutionSpawnInputSchema, type ContextBudgets, type EntityId, type ExecutionSpawnInput } from '@tm8/contract';

import {
  buildSpawnInput,
  contextBudgetsOverrun,
  defaultConfigFor,
  type LaunchConfig,
} from './launch';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}` as EntityId;

function launch(over: Partial<LaunchConfig> = {}): ExecutionSpawnInput {
  const config = { ...defaultConfigFor({ id: uuid(1), agentTool: 'claude-code', model: 'claude-opus-5' }), ...over };
  const input = buildSpawnInput({ clientMutationId: 'cmid-budgets', spaceId: uuid(2), config });
  const parsed = ExecutionSpawnInputSchema.safeParse(input);
  expect(parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)).toEqual([]);
  return input;
}

describe('contextBudgets reach execution.spawn only when set', () => {
  it('no override: the key is absent, so the profile’s budgets hold', () => {
    expect(launch()).not.toHaveProperty('contextBudgets');
  });

  it('an override with no key set is no override', () => {
    expect(launch({ contextBudgets: {} })).not.toHaveProperty('contextBudgets');
    expect(launch({ contextBudgets: { memories: undefined } })).not.toHaveProperty('contextBudgets');
  });

  it('only the keys a person set are sent, verbatim', () => {
    const input = launch({ contextBudgets: { memories: 4096, references: undefined, skills: 0 } });
    expect(input.contextBudgets).toEqual({ memories: 4096, skills: 0 });
    expect(Object.keys(input.contextBudgets ?? {})).toEqual(['memories', 'skills']);
  });

  it('an over-ceiling override is still sent — the node records it, never refuses it', () => {
    const budgets: ContextBudgets = { memories: 20_000, references: 8_000, skills: 8_000 };
    expect(contextBudgetsOverrun(budgets)).not.toBeNull();
    expect(launch({ contextBudgets: budgets }).contextBudgets).toEqual(budgets);
  });
});

/* The node's check, called the way the profile save calls it. */
const NODE_POLICY = { kernelMaxBytes: BYTE_BUDGETS.kernel, manifestMaxBytes: BYTE_BUDGETS.manifest, initialContextMaxBytes: BYTE_BUDGETS.combinedInitialInjection };
const nodeOverrun = (contextBudgets: ContextBudgets) => contextBudgetOverrun({ promptPolicy: NODE_POLICY, contextBudgets });

describe('the ceiling warning agrees with the node', () => {
  it('the room is 32768 minus a 10240 baseline', () => {
    expect(BYTE_BUDGETS.combinedInitialInjection - contextBudgetBaseline(NODE_POLICY)).toBe(22_528);
  });

  const cases: ContextBudgets[] = [
    {},
    { memories: 4096 },
    { skills: 2049 },
    { skills: 2048 },
    { memories: 32_768 },
    { memories: 0, references: 0, skills: 22_528 },
    { memories: 0, references: 0, skills: 22_529 },
    { teammates: 4096 },
  ];
  it.each(cases.map((c) => [JSON.stringify(c), c] as const))('%s', (_, budgets) => {
    const node = nodeOverrun(budgets);
    const sheet = contextBudgetsOverrun(budgets);
    // The node checks every profile that sets budgets; an EMPTY override is
    // not sent, so the sheet has nothing to warn about.
    if (Object.keys(budgets).length === 0) {
      expect(sheet).toBeNull();
      return;
    }
    expect(sheet === null).toBe(node === null);
    if (node && sheet) expect(sheet.over).toBe(node.over);
  });

  it('negative control: a budget exactly at the room is quiet, one byte past is warned', () => {
    expect(contextBudgetsOverrun({ skills: 2048 })).toBeNull();
    expect(contextBudgetsOverrun({ skills: 2049 })).toEqual({ promised: 22_529, room: 22_528, over: 1 });
  });
});
