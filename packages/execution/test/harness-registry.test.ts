/**
 * Registry invariants, and the refusal that is the point of the whole exercise.
 *
 * These assert things no existing test can express, because before the registry
 * there was nothing to ask: capabilities were implicit in a chain of string
 * comparisons, and an unregistered tool was whatever the last `else` happened to
 * do with it.
 */
import { describe, expect, it } from 'vitest';

import {
  AGENT_TOOL_BINARIES,
  HARNESSES,
  harnessForBinary,
  harnessIds,
  resolveHarness,
  tryResolveHarness,
} from '../src/harness/registry.js';
import { SpawnError } from '../src/spawn/types.js';
import { buildAgentCommand, withAgentResume } from '../src/spawn/manifest.js';
import type { ConfinementStory, Harness } from '../src/harness/types.js';
import { readConfinement } from '../src/harness/confinement.js';
import { launchFor } from './harness-command-matrix.js';

describe('harness registry', () => {
  it('registers exactly the three harnesses tm8 ships', () => {
    expect(harnessIds()).toEqual(['claude-code', 'codex', 'echo-agent']);
  });

  it('resolves every registered id', () => {
    for (const id of harnessIds()) expect(resolveHarness(id).id).toBe(id);
  });

  it('keys every harness by its own id, so the table cannot drift', () => {
    for (const [key, harness] of Object.entries(HARNESSES)) expect(harness.id).toBe(key);
  });

  it('derives AGENT_TOOL_BINARIES from the harnesses rather than beside them', () => {
    // The 2026-07-28 defect was a tool selection that reached every surface
    // EXCEPT the one picking the binary. Deriving the table is what makes that
    // class of drift unrepresentable.
    expect(AGENT_TOOL_BINARIES).toEqual({
      'claude-code': 'claude',
      codex: 'codex',
      'echo-agent': 'echo-agent',
    });
    for (const id of harnessIds()) {
      expect(harnessForBinary(AGENT_TOOL_BINARIES[id] as string)?.id).toBe(id);
    }
  });

  it('refuses an unregistered id with the pre-registry error shape', () => {
    expect(() => resolveHarness('gemini')).toThrow(SpawnError);
    try {
      resolveHarness('gemini');
      expect.unreachable('resolveHarness must throw for an unregistered id');
    } catch (error) {
      expect(error).toBeInstanceOf(SpawnError);
      expect((error as SpawnError).code).toBe('invalid_input');
      expect((error as Error).message).toBe('unsupported agent tool: gemini');
    }
    expect(tryResolveHarness('gemini')).toBeNull();
  });

  it('treats an unregistered BINARY as an operator wrapper, not an error', () => {
    // `TM8_AGENT_CMD=/opt/wrap/agent` is a complete operator-owned command whose
    // private flag vocabulary tm8 must not guess at. That is a null, not a throw.
    expect(harnessForBinary('/opt/wrap/agent')).toBeNull();
    expect(
      buildAgentCommand(launchFor('claude-code', 'auto', null, null), {
        TM8_AGENT_CMD: '/opt/wrap/agent --flag',
      }),
    ).toBe('/opt/wrap/agent --flag');
  });

  it('gives every harness a complete capability record — no field defaulted', () => {
    for (const harness of Object.values(HARNESSES)) {
      const capabilities = harness.capabilities as Record<string, unknown>;
      for (const field of [
        'credentialProvider',
        'configDirName',
        'systemPromptDelivery',
        'taskPromptDelivery',
        'resume',
        'acceptsPreMintedSessionId',
        'workspaceTrust',
        'commandNetwork',
        'confinement',
        'transcriptDialect',
      ]) {
        expect(capabilities, `${harness.id}.${field}`).toHaveProperty(field);
        expect(capabilities[field], `${harness.id}.${field}`).not.toBeUndefined();
      }
    }
  });

  it('names a runnable probe wherever confinement claims to be probed', () => {
    // A probe id with no probe behind it is a registry error, not a runtime
    // surprise — `sandbox-probe.ts` exists because inference was tried and was
    // wrong, so a harness may not claim a probe tm8 cannot actually run.
    const runnable = new Set(['codex-bwrap']);
    for (const harness of Object.values(HARNESSES)) {
      const confinement = harness.capabilities.confinement;
      if (typeof confinement === 'object') expect(runnable).toContain(confinement.probe);
    }
  });

  it('never leaves confinement unstated for a shipped harness', () => {
    for (const harness of Object.values(HARNESSES)) {
      expect(harness.capabilities.confinement, harness.id).not.toBe('unknown');
    }
  });

  describe('resume refusal', () => {
    it('refuses a harness that declares no resume-by-id contract', () => {
      // echo-agent must never be silently restarted fresh and presented as
      // resumed. The registry makes this automatic rather than something each
      // new harness has to remember to ask for.
      expect(resolveHarness('echo-agent').capabilities.resume).toBeNull();
      try {
        withAgentResume('node /x/echo.mjs', 'sys', launchFor('echo-agent', 'auto', null, null), 'nid', {});
        expect.unreachable('resume must refuse a harness with no resume contract');
      } catch (error) {
        expect((error as SpawnError).code).toBe('invalid_input');
        expect((error as Error).message).toBe(
          "agent tool 'echo-agent' has no resume-by-id contract",
        );
      }
    });

    it('uses exact-id resume only — never --continue or --last', () => {
      // Both mean "most recent", which resumes the WRONG conversation the moment
      // two sessions share a cwd. On a shared server that is the normal case.
      for (const tool of ['claude-code', 'codex'] as const) {
        const launch = launchFor(tool, 'auto', null, null);
        const resumed = withAgentResume(buildAgentCommand(launch, {}), '', launch, 'nid-1', {});
        expect(resumed).not.toContain('--continue');
        expect(resumed).not.toContain('--last');
        expect(resumed).toContain('nid-1');
      }
    });
  });
});

/**
 * THE REFUSAL THIS PHASE EXISTS FOR.
 *
 * `resolveSandboxPosture` used to open with `if (launch.agentTool !== 'codex')
 * return CONFINED` — a negative predicate, correct for exactly two tools. A
 * third harness fell through it and was reported CONFINED having been probed
 * for nothing: the SAFE answer on NO evidence.
 *
 * These exercise `readConfinement`, which is the function SpawnService itself
 * calls — not a restatement of it. They run against a FIXTURE harness because
 * no shipped harness may declare `unknown` (the invariant above enforces that),
 * so constructing the case the old code silently mishandled is the only way to
 * observe the refusal.
 */
describe('unknown confinement refuses rather than yielding CONFINED', () => {
  const fixture = (confinement: ConfinementStory): Harness => ({
    ...resolveHarness('claude-code'),
    id: 'fixture-agent',
    capabilities: { ...resolveHarness('claude-code').capabilities, confinement },
  });

  it('REFUSES an unknown confinement story', () => {
    const declared = readConfinement(fixture('unknown'));
    expect(declared.kind).toBe('refuse');
    // The refusal must say what to do about it, not merely decline.
    expect(declared.kind === 'refuse' && declared.reason).toContain('fixture-agent');
    expect(declared.kind === 'refuse' && declared.reason).toContain('Refusing rather than assuming');
  });

  it("does NOT report it as confined — the old code's answer", () => {
    expect(readConfinement(fixture('unknown')).kind).not.toBe('confined');
  });

  it('degrades loudly, not silently, for an honestly unconfined harness', () => {
    const declared = readConfinement(fixture('unconfined'));
    expect(declared.kind).toBe('degraded');
    expect(declared.kind === 'degraded' && declared.detail).toContain('no confinement mechanism');
  });

  it('keeps the two shipped CONFINED answers exactly where they were', () => {
    // claude-code enforces internally; echo-agent runs no arbitrary commands.
    // Both resolved CONFINED before this refactor and must still.
    expect(readConfinement(resolveHarness('claude-code')).kind).toBe('confined');
    expect(readConfinement(resolveHarness('echo-agent')).kind).toBe('confined');
  });

  it("routes codex to the probe — its answer is measured, never declared", () => {
    const declared = readConfinement(resolveHarness('codex'));
    expect(declared).toEqual({ kind: 'probe', probe: 'codex-bwrap' });
  });
});
