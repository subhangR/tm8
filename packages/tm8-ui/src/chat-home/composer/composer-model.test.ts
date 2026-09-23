import { describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import type { ChatModelOption, ChatTeammateOption } from '../types';
import {
  MODE_SPECS,
  capWorkerAccess,
  coordinatorModelChoices,
  crewBrief,
  effortAvailability,
  modeConflict,
  modeFromSlash,
  nearestEffort,
  newCrewWorker,
  nonDefaultOptionCount,
  rungFromPermissionMode,
  teammateRoster,
  workerAccessOptions,
} from './composer-model';

const tm = (id: string, mode?: ChatTeammateOption['mode']): ChatTeammateOption => ({
  id: id as EntityId,
  label: id,
  ...(mode === undefined ? {} : { mode }),
});

const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'anthropic', agentTool: 'claude-code', efforts: ['low', 'medium', 'high', 'max'] },
  { model: 'gpt-5.6-sol', label: 'OpenAI GPT 5.6', provider: 'openai', agentTool: 'codex', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { model: 'custom-x', label: 'Custom X', provider: 'custom', agentTool: 'claude-code' },
];

describe('modes', () => {
  it('covers the six schema values in three groups, each with a consequence', () => {
    expect(MODE_SPECS.map((m) => m.id).sort()).toEqual(['ask', 'build', 'craft', 'explain', 'orchestrate', 'plan']);
    for (const spec of MODE_SPECS) expect(spec.consequence.length).toBeGreaterThan(10);
    expect(MODE_SPECS.filter((m) => m.group === 'act').map((m) => m.id)).toEqual(['build', 'orchestrate']);
  });
  it('reads /build on an empty input and nothing else', () => {
    expect(modeFromSlash('/build')).toBe('build');
    expect(modeFromSlash('  /ask ')).toBe('ask');
    expect(modeFromSlash('/build now')).toBeNull();
    expect(modeFromSlash('/nope')).toBeNull();
  });
});

describe('permissions as a ceiling', () => {
  it('flags BUILD under Read-only and names the raise', () => {
    const conflict = modeConflict('build', 'read-only');
    expect(conflict?.required).toBe('ask-first');
    expect(conflict?.raiseLabel).toBe('Raise to Ask first');
  });
  it('does not flag a read mode under a high ceiling', () => {
    expect(modeConflict('ask', 'auto')).toBeNull();
    expect(modeConflict('orchestrate', 'ask-first')).toBeNull();
  });
  it('folds team_members.permission_mode onto the ladder', () => {
    expect(rungFromPermissionMode('bypassPermissions')).toBe('auto');
    expect(rungFromPermissionMode('acceptEdits')).toBe('auto');
    expect(rungFromPermissionMode('plan')).toBe('read-only');
    expect(rungFromPermissionMode(null)).toBe('ask-first');
  });
  it('caps a worker at the thread and never above', () => {
    expect(capWorkerAccess('read-only', 'acceptEdits')).toEqual({ accessMode: 'plan', capped: true });
    expect(capWorkerAccess('auto', 'safe')).toEqual({ accessMode: 'safe', capped: false });
    expect(capWorkerAccess('ask-first', null)).toEqual({ accessMode: 'safe', capped: false });
    const options = workerAccessOptions('ask-first');
    expect(options.find((o) => o.id === 'acceptEdits')?.disabledReason).toMatch(/ceiling/);
    expect(options.find((o) => o.id === 'safe')?.disabledReason).toBeUndefined();
  });
});

describe('teammate roster under orchestrate', () => {
  const roster = [tm('worker-a', 'worker'), tm('coord-b', 'coordinator'), tm('coord-c', 'coordinated-coordinator'), tm('none-d', null)];
  it('filters to coordinators and preselects the first', () => {
    const result = teammateRoster(roster, 'orchestrate', '');
    expect(result.options.map((o) => o.id)).toEqual(['coord-b', 'coord-c']);
    expect(result.preselect).toBe('coord-b');
    expect(result.note).toBeNull();
  });
  it('keeps a current selection that is already a coordinator', () => {
    expect(teammateRoster(roster, 'orchestrate', 'coord-c' as EntityId).preselect).toBeNull();
  });
  it('degrades to everyone, with a note, when no coordinator exists', () => {
    const result = teammateRoster([tm('a', 'worker'), tm('b', 'dispatcher')], 'orchestrate', '');
    expect(result.options).toHaveLength(2);
    expect(result.note).toMatch(/No coordinator teammate/);
  });
  it('says when the node projects no roles at all', () => {
    const result = teammateRoster([tm('a'), tm('b')], 'orchestrate', '');
    expect(result.options).toHaveLength(2);
    expect(result.note).toMatch(/does not project teammate roles/);
  });
  it('leaves every other mode unfiltered', () => {
    expect(teammateRoster(roster, 'build', '').options).toHaveLength(4);
  });
});

describe('models and effort', () => {
  it('lists codex models for the coordinator disabled with a reason, never omitted', () => {
    const choices = coordinatorModelChoices(MODELS);
    expect(choices).toHaveLength(3);
    expect(choices[1]?.disabledReason).toMatch(/Claude Code only/);
    expect(choices[0]?.disabledReason).toBeUndefined();
  });
  it('disables the effort dial with a reason when the model declares no stops', () => {
    expect(effortAvailability(MODELS[2]).disabledReason).toMatch(/does not declare effort stops/);
    expect(effortAvailability(undefined).disabledReason).toBe('pick a model first');
    expect(effortAvailability(MODELS[0]).stops).toEqual(['low', 'medium', 'high', 'max']);
  });
  it('snaps a remembered effort to the nearest stop the model offers', () => {
    expect(nearestEffort('xhigh', ['low', 'medium', 'high', 'max'])).toBe('high');
    expect(nearestEffort('max', ['low', 'medium', 'high', 'xhigh', 'max'])).toBe('max');
    expect(nearestEffort('high', [])).toBeNull();
  });
});

describe('the ⚙ slot', () => {
  it('counts only non-default values', () => {
    expect(nonDefaultOptionCount('build', undefined)).toBe(0);
    expect(nonDefaultOptionCount('build', { autoCommit: true, checkout: 'branch', testCommand: 'bun test' })).toBe(2);
  });
});

describe('crew brief', () => {
  it('is empty until a worker has a teammate and a model', () => {
    expect(crewBrief({ workers: [newCrewWorker()] }, { teammates: [], models: MODELS, permission: 'ask-first', options: undefined })).toBe('');
  });
  it('names ids, caps access at the thread, and states the policy', () => {
    const brief = crewBrief(
      { workers: [newCrewWorker({ teammateId: 'coord-b' as EntityId, model: 'gpt-5.6-sol', effort: 'max', accessMode: 'acceptEdits', skills: ['code-review'] })] },
      { teammates: [tm('coord-b', 'worker')], models: MODELS, permission: 'ask-first', options: { autonomy: 'auto-dispatch' } },
    );
    expect(brief).toContain('teamMemberId coord-b');
    expect(brief).toContain('model gpt-5.6-sol via codex');
    expect(brief).toContain('effort max');
    expect(brief).toContain('accessMode safe');
    expect(brief).toContain('skills code-review');
    expect(brief).toContain('autonomy auto-dispatch');
    expect(brief).toContain('thread ceiling Ask first');
  });
});
