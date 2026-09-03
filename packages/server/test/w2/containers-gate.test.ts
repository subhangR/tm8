// The container handler family's two honesty rules (TM8-CONTAINERS-DESIGN §4).
//
//   1. `TM8_CONTAINERS=off` answers 501 not_implemented for EVERY runtime
//      operation — never 404, never a silent success.
//   2. Every `ContainerError` code maps to the closed taxonomy, and the map is
//      total.
//
// Rule 1's real risk is not the gate returning the wrong code; it is a row with
// NO handler at all, which falls through the registry to 404 and tells a caller
// the operation does not exist when it is in the contract. So the first test
// here asserts registration, not behaviour.

import { describe, expect, it } from 'vitest';

import { CollabError, OPERATIONS, type OperationName } from '@tm8/contract';
import { ContainerError } from '@tm8/execution';

import {
  CONTAINER_RUNTIME_OPERATIONS,
  registerW2ContainerHandlers,
  toContainerCollabError,
} from '../../src/facade/handlers/w2/containers.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { ServerConfig } from '../../src/http/config.js';
import type { RequestContext } from '../../src/http/types.js';

const baseConfig = (enabled: boolean): ServerConfig => ({
  host: '127.0.0.1',
  port: 4610,
  uiDir: undefined,
  ui10Dir: undefined,
  maxBodyBytes: 1_000_000,
  databaseUrl: undefined,
  containers: {
    enabled,
    providers: ['fake'],
    cap: 4,
    execCap: 8,
    dataDir: '/tmp/tm8/containers',
    imageRegistry: 'ghcr.io/subhangr/tm8',
    keepFailed: false,
  },
} as ServerConfig);

const ctx = (): RequestContext => ({} as RequestContext);

function registryWith(enabled: boolean): HandlerRegistry {
  const registry = new HandlerRegistry();
  registerW2ContainerHandlers(registry, { config: baseConfig(enabled) });
  return registry;
}

describe('every containers.* row is REGISTERED, built or not', () => {
  // A `status: 'v1'` catalog row with no handler answers 404. That is the
  // defect this test exists for: it is invisible in a handler test, because
  // there is no handler to test.
  it('registers a handler for every runtime operation in the family', () => {
    const registry = registryWith(true);
    for (const name of CONTAINER_RUNTIME_OPERATIONS) {
      expect(registry.has(name), `${name} has no handler and would 404`).toBe(true);
    }
  });

  it('covers every containers.* catalog row except the socket alias', () => {
    const registry = registryWith(true);
    const family = OPERATIONS
      .filter((op) => op.name.startsWith('containers.'))
      .map((op) => op.name);
    expect(family).toHaveLength(25);
    const unregistered = family.filter((name) => !registry.has(name as OperationName));
    // `containers.stream` is the ONLY row without a handler here, and that is
    // correct: it re-declares `events.subscribe`'s socket and is served by the
    // WS upgrade handler, not by the HTTP registry.
    expect(unregistered).toEqual(['containers.stream']);
  });
});

describe('TM8_CONTAINERS=off answers 501 for every runtime operation', () => {
  it('refuses each one with not_implemented FOR THE GATE\'S REASON — and never does so with the gate on', async () => {
    // A DIFFERENTIAL, and it has to be one. Asserting `code: 'not_implemented'`
    // alone proved nothing here: 501 is also what this family answers when the
    // gate is ON, because every handler is still `unbound` and the P0 ops have
    // no service composed. So the code is the failure mode of the SETUP as well
    // as of the gate, and the old single-arm version of this test stayed green
    // with the gate deleted entirely.
    //
    // Composing a `ContainerService` does NOT rescue it — there is nothing
    // behind the service to reach until P1 binds the handler bodies. The only
    // signal that distinguishes gate-off from every other 501 in P0 is the
    // REASON, so both arms assert on that.
    //
    //   gate OFF -> every op cites TM8_CONTAINERS=off
    //   gate ON  -> no op cites it (it 501s for a different, honest reason)
    //
    // Delete the gate and the off-arm fails on the FIRST operation in the
    // loop — one reported failure, not 24. The loop's value is that no
    // operation can quietly opt out, not that they all report.
    const off = registryWith(false);
    const on = registryWith(true);
    for (const name of CONTAINER_RUNTIME_OPERATIONS) {
      const offHandler = off.get(name);
      expect(offHandler, name).toBeDefined();
      await expect(offHandler!(ctx()), name).rejects.toMatchObject({
        code: 'not_implemented',
      });
      await expect(offHandler!(ctx()), `${name} must cite the gate when off`)
        .rejects.toThrow(/TM8_CONTAINERS=off/);

      const onHandler = on.get(name);
      expect(onHandler, name).toBeDefined();
      await expect(onHandler!(ctx()), `${name} must NOT cite the gate when on`)
        .rejects.not.toThrow(/TM8_CONTAINERS=off/);
    }
  });

  it('names the gate in the message, so an operator knows which knob to turn', async () => {
    const registry = registryWith(false);
    await expect(registry.get('containers.create')!(ctx()))
      .rejects.toThrow(/TM8_CONTAINERS=off/);
  });

  it('gives ONE consistent REASON for the whole family when off, while naming each op', async () => {
    // Two things at once, and they pull in opposite directions. The message
    // must NAME the operation — that is the house's standard 501 envelope, and
    // an operator reading a log needs to know which call refused. But the
    // REASON must not vary: with containers off, a node must not give a
    // different explanation per operation depending on which phase shipped it.
    // So the name is a prefix and the reason is uniform, and this asserts both.
    const registry = registryWith(false);
    const reasons = new Set<string>();
    for (const name of CONTAINER_RUNTIME_OPERATIONS) {
      try {
        await registry.get(name)!(ctx());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        expect(message, name).toContain(name);
        reasons.add(message.slice(`${name}: `.length));
      }
    }
    expect(reasons.size).toBe(1);
    expect([...reasons][0]).toContain('TM8_CONTAINERS=off');
  });
});

describe('with the gate ON, the unbuilt operations still answer honestly', () => {
  it('answers 501 with a NAMED reason, not a bare code', async () => {
    const registry = registryWith(true);
    await expect(registry.get('containers.attach')!(ctx())).rejects.toMatchObject({
      code: 'not_implemented',
    });
    await expect(registry.get('containers.attach')!(ctx()))
      .rejects.toThrow(/containers\.attach: .*stream bridge \(phase 2\)/);
    await expect(registry.get('containers.expose')!(ctx()))
      .rejects.toThrow(/phase 3/);
  });

  it('does not claim the gate is off when it is on', async () => {
    const registry = registryWith(true);
    await expect(registry.get('containers.attach')!(ctx()))
      .rejects.not.toThrow(/TM8_CONTAINERS=off/);
  });

  it('answers 501 — not a crash — when no service is composed', async () => {
    // The gate is on and the op is in the P0 set, but nothing wired a runtime.
    // An honest 501 beats dereferencing a service that was never built.
    const registry = registryWith(true);
    await expect(registry.get('containers.create')!(ctx())).rejects.toMatchObject({
      code: 'not_implemented',
    });
  });
});

describe('ContainerError maps onto the closed taxonomy (§4.3)', () => {
  const cases: Array<[ConstructorParameters<typeof ContainerError>[1], string]> = [
    ['invalid_spec', 'invalid_input'],
    ['not_found', 'not_found'],
    ['forbidden', 'forbidden'],
    ['policy', 'forbidden'],
    ['state', 'invariant_violation'],
    ['budget', 'limit_exceeded'],
    ['no_provider', 'not_implemented'],
    ['runtime', 'upstream_unavailable'],
    ['timeout', 'upstream_unavailable'],
  ];

  for (const [code, taxonomy] of cases) {
    it(`maps ${code} to ${taxonomy}`, () => {
      const mapped = toContainerCollabError(new ContainerError('x', code, { a: 1 }));
      expect((mapped as CollabError).code).toBe(taxonomy);
    });
  }

  it('distinguishes `policy` (403, a refusal) from `no_provider` (501, a gap)', () => {
    // The pair that is easy to conflate and expensive to get wrong. `policy`
    // means the node COULD run this but not at an isolation class the policy
    // accepts — actionable by changing the policy or the provider. Answering
    // 501 there would tell an operator to install something they already have.
    expect((toContainerCollabError(new ContainerError('x', 'policy')) as CollabError).code)
      .toBe('forbidden');
    expect((toContainerCollabError(new ContainerError('x', 'no_provider')) as CollabError).code)
      .toBe('not_implemented');
  });

  it('carries the detail through, so a refusal stays actionable', () => {
    const mapped = toContainerCollabError(
      new ContainerError('too many', 'budget', { cap: 4, nodeId: 'node-a' }),
    );
    expect((mapped as CollabError).details).toMatchObject({ cap: 4, nodeId: 'node-a' });
  });

  it('passes a non-ContainerError through untouched', () => {
    const other = new Error('something else');
    expect(toContainerCollabError(other)).toBe(other);
  });
});
