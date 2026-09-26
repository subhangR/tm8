// Launch card v3, lane B: what resume reads back from the launch record
// (decision 2: effort replays; decision 1: in-full ids are re-read) and how a
// prompt-budget refusal is worded on the wire.
import { BudgetExceededError, BYTE_BUDGETS } from '@tm8/prompt';
import { describe, expect, it } from 'vitest';

import { budgetRefusalDetails, sessionLaunchPostureFromRecord } from '../src/facade/execution-handlers.js';

const ROW = {
  access_mode: 'auto', permission_mode: null, credential_source: null, credential_sources: {},
  space_credential_ids: null, harness_choice: null,
};

describe('sessionLaunchPostureFromRecord', () => {
  it('carries launch.reasoningEffort, inFullIds and jevRemovedIds to resume', () => {
    const posture = sessionLaunchPostureFromRecord({
      ...ROW, reasoning_effort: 'xhigh', in_full_ids: ['a'], jev_removed_ids: ['b'],
    });
    expect(posture).toMatchObject({ reasoningEffort: 'xhigh', inFullIds: ['a'], jevRemovedIds: ['b'] });
  });

  it('a launch that recorded none of them reads back without them', () => {
    const posture = sessionLaunchPostureFromRecord({ ...ROW, reasoning_effort: null, in_full_ids: null, jev_removed_ids: null });
    expect(posture).not.toHaveProperty('reasoningEffort');
    expect(posture).not.toHaveProperty('inFullIds');
    expect(posture).not.toHaveProperty('jevRemovedIds');
  });
});

describe('budgetRefusalDetails (payload_too_large)', () => {
  it('names the in-full budget in_full_budget with limitBytes and bytes', () => {
    expect(budgetRefusalDetails(new BudgetExceededError('inFullInjection', 30_000, BYTE_BUDGETS.inFullInjection)))
      .toMatchObject({ reason: 'in_full_budget', limitBytes: BYTE_BUDGETS.inFullInjection, bytes: 30_000 });
  });

  it('names the whole launch launch_total, critical memories included', () => {
    for (const material of ['combinedInitialInjection', 'memoryInjection'] as const) {
      expect(budgetRefusalDetails(new BudgetExceededError(material, 40_000, 32_768)))
        .toMatchObject({ reason: 'launch_total', limitBytes: 32_768, bytes: 40_000, material });
    }
  });
});
