/**
 * Conformance S6 and B3 — the secret scanner.
 *
 * §18.3: "Tokens are passed by scoped environment or protected IPC and never
 * serialized into manifest, graph, logs, prompts, or provider events." The
 * manifest carries the env var NAME; the VALUE lives only in the PTY child's
 * environment. This file proves the whole produced-artifact set is clean, not
 * just the manifest — the leak that matters is the one in the prompt or the
 * log line, because those are the artifacts nobody re-reads.
 *
 * Note on honesty: Phase 1 has NO bearer authentication. The server resolves a
 * loopback auto-owner identity from the database. `TM8_AGENT_TOKEN` is the
 * seam, modelled so the value can never leak once it exists. This test does
 * not pretend an auth flow exists.
 */
import { describe, expect, it } from 'vitest';

import {
  BEARER_ENV,
  RETIRED_BEARER_ENV,
  assertNoSecrets,
  composeBootstrapManifest,
  composeHarnessBootstrap,
  scanForSecrets,
  SecretLeakError,
  serializeBootstrapManifest,
  type BootstrapManifestInput,
} from '../../src/harness/index.js';
import { BYTE_BUDGETS, utf8Bytes } from '@tm8/prompt';

const TOKEN = 'tm8_sk_live_9f3c2a7e5b1d4086af22c1907e6b3d55';

const INPUT: BootstrapManifestInput = {
  server: {
    id: 'srv_1',
    baseUrl: 'http://127.0.0.1:4610',
    catalogDigest: 'sha256:cat',
    capabilityEpoch: 'cap_9',
  },
  identity: { actorId: 'ent_actor', teamMemberId: 'ent_tm', displayName: 'Atlas', mode: 'worker' },
  session: {
    id: 'ses_1',
    spaceId: 'spc_1',
    cwd: '/srv/work/tm8',
    workdirMode: 'project',
    runtimeMode: 'native-interactive-pty',
    launchProjectId: 'prj_1',
    trust: 'trusted',
    coordinatorSessionId: 'ses_coord',
  },
  interactionProfile: {
    entityId: 'ent_profile',
    version: 7,
    source: 'teammate_default',
    pinRevision: 1,
    resolvedHash: 'sha256:prof',
    providerCaptureMode: 'explicit-only',
    pinRef: 'tm8://work-session/ses_1/interaction-profile-pin',
  },
  assignment: { primaryTaskId: 'tsk_1', taskIds: ['tsk_1'] },
  routing: { inboxOwnerId: 'ent_tm', eventAfterSeq: 1482 },
};

describe('the scanner itself detects a leak', () => {
  it('finds a token value planted in any artifact, and names which one', () => {
    // PROBE: the scanner must fail on input that SHOULD fail, or its clean
    // verdict on the real artifacts below means nothing.
    const findings = scanForSecrets(
      { manifest: '{"credential":{"bearerEnv":"TM8_AGENT_TOKEN"}}', prompt: `export ${TOKEN}` },
      { TM8_AGENT_TOKEN: TOKEN },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.artifact).toBe('prompt');
    expect(findings[0]?.secretName).toBe('TM8_AGENT_TOKEN');
  });

  it('does not confuse the env var NAME for its value', () => {
    expect(
      scanForSecrets({ manifest: `"bearerEnv":"${BEARER_ENV}"` }, { TM8_AGENT_TOKEN: TOKEN }),
    ).toEqual([]);
  });

  it('ignores an empty or absent secret rather than matching everything', () => {
    // A blank secret is a substring of every string; a naive scanner reports
    // every artifact as leaking and is then switched off by whoever is on call.
    expect(scanForSecrets({ a: 'anything' }, { TM8_AGENT_TOKEN: '', OTHER: undefined })).toEqual([]);
  });

  it('assertNoSecrets throws with the artifact name and never echoes the value', () => {
    try {
      assertNoSecrets({ prompt: `bearer ${TOKEN}` }, { TM8_AGENT_TOKEN: TOKEN });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SecretLeakError);
      const message = (err as Error).message;
      expect(message).toContain('prompt');
      expect(message).toContain('TM8_AGENT_TOKEN');
      expect(message).not.toContain(TOKEN);
    }
  });
});

describe('B3/S6 — no produced artifact contains a token value', () => {
  it('scans the manifest, kernel, bootstrap control block and log line together', () => {
    const bootstrap = composeHarnessBootstrap({
      input: INPUT,
      manifestPath: '/run/tm8/ses_1.manifest.json',
    });
    const artifacts = {
      manifest: bootstrap.manifestJson,
      kernel: bootstrap.kernel,
      control: bootstrap.control,
      combined: bootstrap.injection,
      log: bootstrap.logLine,
    };
    // Every artifact is non-trivial — a scanner over empty strings is vacuous.
    for (const [name, text] of Object.entries(artifacts)) {
      expect(text.length, name).toBeGreaterThan(40);
    }
    expect(scanForSecrets(artifacts, { TM8_AGENT_TOKEN: TOKEN })).toEqual([]);
    // And the retired literal appears nowhere at all.
    for (const [name, text] of Object.entries(artifacts)) {
      expect(text, name).not.toContain(RETIRED_BEARER_ENV);
    }
  });

  it('names the env var in the manifest and nowhere leaks a value-shaped field', () => {
    const text = serializeBootstrapManifest(composeBootstrapManifest(INPUT));
    expect(text).toContain('"bearerEnv":"TM8_AGENT_TOKEN"');
    expect(text).not.toMatch(/"(token|bearer|secret|apiKey|password|authorization)"\s*:/i);
  });

  it('keeps the combined initial injection under the 32 KiB ceiling (B2)', () => {
    const bootstrap = composeHarnessBootstrap({
      input: INPUT,
      manifestPath: '/run/tm8/ses_1.manifest.json',
    });
    expect(utf8Bytes(bootstrap.injection)).toBeLessThanOrEqual(
      BYTE_BUDGETS.combinedInitialInjection,
    );
    expect(utf8Bytes(bootstrap.manifestJson)).toBeLessThanOrEqual(BYTE_BUDGETS.manifest);
    expect(utf8Bytes(bootstrap.kernel)).toBeLessThanOrEqual(BYTE_BUDGETS.kernel);
  });

  it('gives a coordinator the §14.2 control block, a worker the §14.1 one', () => {
    const worker = composeHarnessBootstrap({ input: INPUT, manifestPath: '/m.json' });
    expect(worker.control).toContain('type="tm8.worker-bootstrap"');
    const coordinator = composeHarnessBootstrap({
      input: { ...INPUT, identity: { ...INPUT.identity, mode: 'coordinator' } },
      manifestPath: '/m.json',
    });
    expect(coordinator.control).toContain('type="tm8.coordinator-bootstrap"');
  });
});
