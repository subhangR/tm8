/**
 * The agent bootstrap manifest, version 2 (harness §5.1) — the ONLY file a
 * booting agent reads, and the only place a mis-scoped field becomes a
 * permanent artifact on disk, in a backup, and in the graph row that records
 * it. Its rules are therefore negative as much as positive: nine top-level
 * keys, 4,096 UTF-8 bytes, and a `credential` object that carries a NAME.
 */
import { describe, expect, it } from 'vitest';

import {
  BEARER_ENV,
  BOOTSTRAP_MANIFEST_KEYS,
  DISCOVERY_ARGV,
  GRAMMAR_VERSION,
  InvalidBootstrapManifestError,
  composeBootstrapManifest,
  parseBootstrapManifest,
  serializeBootstrapManifest,
  type BootstrapManifestInput,
} from '../../src/harness/index.js';
import { BYTE_BUDGETS, BudgetExceededError, utf8Bytes } from '@tm8/prompt';

const INPUT: BootstrapManifestInput = {
  server: {
    id: 'srv_1',
    baseUrl: 'http://127.0.0.1:4610',
    catalogDigest: 'sha256:cat',
    capabilityEpoch: 'cap_9',
  },
  identity: {
    actorId: 'ent_actor',
    teamMemberId: 'ent_tm',
    displayName: 'Atlas',
    mode: 'worker',
  },
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
  assignment: { primaryTaskId: 'tsk_1', taskIds: ['tsk_1', 'tsk_2'] },
  routing: { inboxOwnerId: 'ent_tm', eventAfterSeq: 1482 },
};

describe('shape', () => {
  it('has exactly the nine §5.1 top-level keys, in order', () => {
    const manifest = composeBootstrapManifest(INPUT);
    expect(Object.keys(manifest)).toEqual([...BOOTSTRAP_MANIFEST_KEYS]);
    expect([...BOOTSTRAP_MANIFEST_KEYS]).toEqual([
      'manifestVersion',
      'server',
      'credential',
      'identity',
      'session',
      'interactionProfile',
      'assignment',
      'routing',
      'discovery',
    ]);
  });

  it('pins manifestVersion 2 and grammarVersion 2', () => {
    const manifest = composeBootstrapManifest(INPUT);
    expect(manifest.manifestVersion).toBe('2');
    expect(manifest.server.grammarVersion).toBe('2');
    expect(GRAMMAR_VERSION).toBe('2');
  });

  it('spells the three discovery roots as ARGV ARRAYS with {entityId} placeholders', () => {
    // Argv arrays, not a shell string: the agent's runtime execs these, and a
    // space-joined string would need quoting rules the manifest cannot carry.
    // (§14.1's prompt-facing form deliberately differs — see the prompt tests.)
    const { discovery } = composeBootstrapManifest(INPUT);
    expect(discovery.root).toEqual(['tm8', 'help', '--format', 'json']);
    expect(discovery.actions).toEqual([
      'tm8',
      'action',
      'list',
      '--for',
      '{entityId}',
      '--format',
      'json',
    ]);
    expect(discovery.context).toEqual([
      'tm8',
      'entity',
      'context',
      '{entityId}',
      '--format',
      'json',
    ]);
    expect(discovery).toEqual(DISCOVERY_ARGV);
    for (const argv of Object.values(discovery)) {
      expect(Array.isArray(argv)).toBe(true);
      expect(argv).not.toContain('ENTITY_ID');
    }
  });

  it('OMITS absent optional fields rather than emitting null collections', () => {
    const manifest = composeBootstrapManifest({
      ...INPUT,
      // scratch, because §5.1 permits a null launchProjectId ONLY for scratch.
      session: {
        ...INPUT.session,
        workdirMode: 'scratch',
        launchProjectId: null,
        coordinatorSessionId: null,
      },
      assignment: { primaryTaskId: null, taskIds: [] },
    });
    expect('coordinatorSessionId' in manifest.session).toBe(false);
    expect('primaryTaskId' in manifest.assignment).toBe(false);
    expect('taskIds' in manifest.assignment).toBe(false);
    // launchProjectId is `null` ONLY for scratch — §5.1 states that explicitly,
    // so a null here is a claim, not an omission.
    expect(manifest.session.launchProjectId).toBeNull();
    expect(JSON.stringify(manifest)).not.toContain('[]');
  });
});

describe('the 4,096-byte hard cap', () => {
  it('a realistic manifest fits, with room to spare', () => {
    const bytes = utf8Bytes(serializeBootstrapManifest(composeBootstrapManifest(INPUT)));
    expect(bytes).toBeLessThanOrEqual(BYTE_BUDGETS.manifest);
    expect(bytes).toBeGreaterThan(500); // not vacuous — this is a real manifest
  });

  it('REFUSES an oversized manifest instead of writing a truncated one', () => {
    // The cap must see a near-limit input or it proves nothing. 400 task ids
    // is the realistic way a manifest grows past 4 KiB.
    const many = Array.from({ length: 400 }, (_, i) => `tsk_${String(i).padStart(6, '0')}`);
    expect(() =>
      serializeBootstrapManifest(
        composeBootstrapManifest({
          ...INPUT,
          assignment: { primaryTaskId: 'tsk_1', taskIds: many },
        }),
      ),
    ).toThrow(BudgetExceededError);
  });
});

describe('what the manifest MUST NOT contain (§5.1)', () => {
  it('rejects task descriptions, memory, skill bodies and transcripts at the door', () => {
    for (const key of ['tasks', 'memory', 'skills', 'promptExtra', 'transcript', 'projects']) {
      expect(() =>
        composeBootstrapManifest({ ...INPUT, [key]: ['anything'] } as BootstrapManifestInput),
      ).toThrow(InvalidBootstrapManifestError);
    }
  });

  it('carries no operation inventory, command schema, or copied help prose', () => {
    const text = serializeBootstrapManifest(composeBootstrapManifest(INPUT));
    // The 81-row catalog would show up as operation names; none may appear.
    expect(text).not.toMatch(/entities\.(get|patch|create)/);
    expect(text).not.toMatch(/inputSchema|outputSchema|operations/i);
    // Three discovery argv arrays and nothing that reads like a table.
    expect(text.match(/"tm8"/g)).toHaveLength(3);
  });

  it('carries no mutable permission assertion', () => {
    const text = serializeBootstrapManifest(composeBootstrapManifest(INPUT)).toLowerCase();
    for (const claim of ['you may', 'allowed to', 'permissions', 'canedit', 'admin']) {
      expect(text).not.toContain(claim);
    }
  });
});

describe('credential scoping (§5.3, S6)', () => {
  it('names TM8_AGENT_TOKEN and nothing else — `credential` has exactly one field', () => {
    const { credential } = composeBootstrapManifest(INPUT);
    expect(credential).toEqual({ bearerEnv: 'TM8_AGENT_TOKEN' });
    expect(Object.keys(credential)).toEqual(['bearerEnv']);
    expect(BEARER_ENV).toBe('TM8_AGENT_TOKEN');
  });

  it('never contains the RETIRED literal TM8_AUTH_TOKEN', () => {
    expect(serializeBootstrapManifest(composeBootstrapManifest(INPUT))).not.toContain(
      'TM8_AUTH_TOKEN',
    );
  });
});

describe('interaction profile validation (§5.1, P3, R3)', () => {
  it('accepts only the four resolution sources', () => {
    for (const source of [
      'spawn_override',
      'teammate_default',
      'space_default',
      'core_default',
    ] as const) {
      expect(
        composeBootstrapManifest({
          ...INPUT,
          interactionProfile: { ...INPUT.interactionProfile, source },
        }).interactionProfile.source,
      ).toBe(source);
    }
    expect(() =>
      composeBootstrapManifest({
        ...INPUT,
        interactionProfile: { ...INPUT.interactionProfile, source: 'guessed' },
      } as unknown as BootstrapManifestInput),
    ).toThrow(InvalidBootstrapManifestError);
  });

  it('refuses any providerCaptureMode other than explicit-only', () => {
    // R3: "any other value fails validation or visibly falls back to core."
    // This composer fails closed; a caller that prefers the visible fallback
    // resolves the core profile itself and composes again.
    expect(() =>
      composeBootstrapManifest({
        ...INPUT,
        interactionProfile: {
          ...INPUT.interactionProfile,
          providerCaptureMode: 'capture-if-unpublished',
        },
      } as unknown as BootstrapManifestInput),
    ).toThrow(InvalidBootstrapManifestError);
  });

  it('carries the pin identity, hash and ref but no raw profile policy', () => {
    const { interactionProfile } = composeBootstrapManifest(INPUT);
    expect(interactionProfile.resolvedHash).toBe('sha256:prof');
    expect(interactionProfile.pinRef).toBe(
      'tm8://work-session/ses_1/interaction-profile-pin',
    );
    expect(Object.keys(interactionProfile).sort()).toEqual([
      'entityId',
      'pinRef',
      'pinRevision',
      'providerCaptureMode',
      'resolvedHash',
      'source',
      'version',
    ]);
  });
});

describe('closed vocabularies', () => {
  it('rejects an unknown identity mode, workdir mode, runtime mode or trust value', () => {
    const bad: [keyof BootstrapManifestInput, object][] = [
      ['identity', { ...INPUT.identity, mode: 'supervisor' }],
      ['session', { ...INPUT.session, workdirMode: 'anywhere' }],
      ['session', { ...INPUT.session, runtimeMode: 'headless' }],
      ['session', { ...INPUT.session, trust: 'maybe' }],
    ];
    for (const [key, value] of bad) {
      expect(() =>
        composeBootstrapManifest({ ...INPUT, [key]: value } as BootstrapManifestInput),
      ).toThrow(InvalidBootstrapManifestError);
    }
  });

  it('accepts every legal identity mode, including human-directed and background', () => {
    for (const mode of ['human-directed', 'worker', 'coordinator', 'background'] as const) {
      expect(
        composeBootstrapManifest({ ...INPUT, identity: { ...INPUT.identity, mode } }).identity.mode,
      ).toBe(mode);
    }
  });

  it('requires scratch to be the only workdir mode without a launch project', () => {
    expect(() =>
      composeBootstrapManifest({
        ...INPUT,
        session: { ...INPUT.session, workdirMode: 'project', launchProjectId: null },
      }),
    ).toThrow(InvalidBootstrapManifestError);
    expect(
      composeBootstrapManifest({
        ...INPUT,
        session: { ...INPUT.session, workdirMode: 'scratch', launchProjectId: null },
      }).session.workdirMode,
    ).toBe('scratch');
  });
});

describe('round trip', () => {
  it('parses back what it serialized', () => {
    const manifest = composeBootstrapManifest(INPUT);
    const parsed = parseBootstrapManifest(JSON.parse(serializeBootstrapManifest(manifest)));
    expect(parsed).toEqual(manifest);
  });

  it('returns null for a v1 manifest rather than pretending it is v2', () => {
    expect(parseBootstrapManifest({ manifestVersion: '1', sessionId: 'ws_1' })).toBeNull();
    expect(parseBootstrapManifest(null)).toBeNull();
    expect(parseBootstrapManifest('nope')).toBeNull();
  });
});
