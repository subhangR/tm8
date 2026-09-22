// The rollout gate. These tests are about one property: a node that has not
// opted in constructs nothing, because that is what makes shipping this to a
// fleet a no-op rather than a migration.

import { describe, expect, it, vi } from 'vitest';
import {
  ROSTER_POLICY_ENV,
  ROUTING_POLICY_ENV,
  rosterAdvisorFromEnv,
  rosterPolicyFromEnv,
  routingAdvisorFromEnv,
  routingPolicyFromEnv,
} from '../src/from-env.js';
import { DEFAULT_ROUTING_POLICY } from '../src/advisor.js';

const KEY = 'apikey_test';

describe('routingPolicyFromEnv', () => {
  it('defaults to advise, and reads the three real policies', () => {
    expect(routingPolicyFromEnv({})).toBe(DEFAULT_ROUTING_POLICY);
    expect(routingPolicyFromEnv({})).toBe('advise');
    for (const p of ['off', 'advise', 'auto'] as const) {
      expect(routingPolicyFromEnv({ [ROUTING_POLICY_ENV]: p })).toBe(p);
      expect(routingPolicyFromEnv({ [ROUTING_POLICY_ENV]: ` ${p.toUpperCase()} ` })).toBe(p);
    }
  });

  it('refuses a misspelling instead of quietly defaulting', () => {
    // The failure this prevents: TM8_ROUTING_POLICY=Automatic silently running
    // under `advise` and nobody being able to see why routing "does nothing".
    expect(() => routingPolicyFromEnv({ [ROUTING_POLICY_ENV]: 'automatic' })).toThrow(
      /not a routing policy/,
    );
  });
});

describe('routingAdvisorFromEnv', () => {
  it('builds nothing without a key, and says so once', () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    expect(routingAdvisorFromEnv({ env: {}, logger })).toBeUndefined();
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(String(logger.info.mock.calls[0]?.[0])).toMatch(/no TYPESAFE_API_KEY/);
  });

  it('builds nothing when the policy is off, even with a key', () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const env = { TYPESAFE_API_KEY: KEY, [ROUTING_POLICY_ENV]: 'off' };
    expect(routingAdvisorFromEnv({ env, logger })).toBeUndefined();
    // Silent: `off` is a deliberate choice, not a misconfiguration to report.
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('builds an advisor when both switches are on', () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const advisor = routingAdvisorFromEnv({ env: { JEV_API_KEY: KEY }, logger });
    expect(advisor).toBeDefined();
    expect(logger.info).toHaveBeenCalledWith('jev: model routing is active', { policy: 'advise' });
  });

  it('still declines on a task-less launch, so a built advisor is not a routed one', async () => {
    const advisor = routingAdvisorFromEnv({ env: { JEV_API_KEY: KEY } });
    // No task, no network call: the advisor short-circuits before the client.
    await expect(advisor?.advise(null, {})).resolves.toBeNull();
  });
});

describe('rosterPolicyFromEnv', () => {
  it('defaults OFF — naming a teammate is the decision a human notices', () => {
    expect(rosterPolicyFromEnv({})).toBe('off');
    expect(rosterPolicyFromEnv({ [ROSTER_POLICY_ENV]: ' ON ' })).toBe('on');
  });

  it('refuses a misspelling instead of quietly staying off', () => {
    expect(() => rosterPolicyFromEnv({ [ROSTER_POLICY_ENV]: 'true' })).toThrow(/not a roster policy/);
  });
});

describe('rosterAdvisorFromEnv', () => {
  it('builds nothing on either switch alone', () => {
    // Key but no policy.
    expect(rosterAdvisorFromEnv({ env: { TYPESAFE_API_KEY: KEY } })).toBeUndefined();
    // Policy but no key: reported, because this one IS a misconfiguration —
    // someone asked for selection and will not get it.
    const logger = { info: vi.fn(), warn: vi.fn() };
    expect(rosterAdvisorFromEnv({ env: { [ROSTER_POLICY_ENV]: 'on' }, logger })).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('no TYPESAFE_API_KEY'));
  });

  it('builds a selector when both switches are on', () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const advisor = rosterAdvisorFromEnv({
      env: { TYPESAFE_API_KEY: KEY, [ROSTER_POLICY_ENV]: 'on' },
      logger,
    });
    expect(advisor).toBeDefined();
    expect(logger.info).toHaveBeenCalledWith('jev: teammate selection is active');
  });

  it('still declines on a task-less dispatch, so a built selector is not a deciding one', async () => {
    const advisor = rosterAdvisorFromEnv({
      env: { TYPESAFE_API_KEY: KEY, [ROSTER_POLICY_ENV]: 'on' },
    });
    await expect(advisor?.choose(null, [])).resolves.toBeNull();
  });
});
