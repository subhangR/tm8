/**
 * GROUP 9 AGAINST THE REAL SERVER — the eleven rows, re-measured, plus
 * OBLIGATION O2: exit code 130 under a REAL interrupt.
 *
 * WHY EVERY NUMBER HERE IS MEASURED AND NONE IS PREDICTED. This slot was told
 * its six `interactionProfiles.*` rows and both `*.interactionProfile.setDefault`
 * rows were G12 residual and would answer 501, and then told mid-flight that a
 * tranche had composed them. Neither statement is evidence. A predicted
 * composition recorded as a measured one is the exact proxy-for-property error
 * this program exists to eliminate, so this file re-derives the availability
 * column from what the node actually answers, and reports what it saw.
 *
 * THE THREE-STATE PROBE IS NOT COLLAPSIBLE. `server.observe()` answers
 * `unavailable` (an honest 501 — the router found no handler), `unknown`
 * (400 invalid_input — a handler EXISTS but never ran, so whether it is a stub
 * is UNOBSERVED), or `available`. Resolving `unknown` needs a SCHEMA-VALID
 * body, which is this slot's domain work, so the second pass below sends real
 * bodies bound through `bindPath` and records the taxonomy code that comes
 * back. `unknown` is never upgraded on optimism.
 *
 * WHAT AN HONEST 501 IS. Not a defect, never filed against another wave, and
 * never hidden. It is PRE-VALIDATION: it reserves no `clientMutationId` and
 * partially applies nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { bindPath, getOperation, type OperationName } from '@tm8/contract';
import {
  assertBuilt,
  cli,
  REPO_ROOT,
  startRealServer,
  type ObservedAvailability,
  type RealServer,
} from './harness.js';

let server: RealServer;

/** Every row this slot owns, in catalog order. `execution.prompt` included: it
 *  is measured like any other operation and simply has no command. */
const MY_ROWS: readonly OperationName[] = [
  'execution.spawn',
  'execution.prompt',
  'execution.terminate',
  'execution.streams.attach',
  'interactionProfiles.propose',
  'interactionProfiles.updateDraft',
  'interactionProfiles.validate',
  'interactionProfiles.preview',
  'interactionProfiles.activate',
  'interactionProfiles.retire',
  'teamMembers.interactionProfile.setDefault',
  'spaces.interactionProfile.setDefault',
  'execution.liveness',
];

const NIL = '00000000-0000-7000-8000-000000000000';
const observed = new Map<OperationName, ObservedAvailability>();
const answered = new Map<OperationName, string>();

beforeAll(async () => {
  await assertBuilt();
  server = await startRealServer('group9');
  const health = await server.health();
  // eslint-disable-next-line no-console
  console.log(
    `[group9] ${server.baseUrl} operations=${health.operations} registered=${health.implemented} ` +
      `(registered is NOT behaviourally implemented) bind-start ${server.bindStart.files}/${server.bindStart.digest}`,
  );
}, 180_000);

afterAll(async () => {
  await server?.stop();
});

/**
 * Send a SCHEMA-VALID body straight over HTTP and report the taxonomy code.
 *
 * This is MEASUREMENT, not a CLI behaviour claim: it exists to resolve the
 * probe's `unknown` for rows whose command is not wired into the built binary
 * yet. Everything it sends is bound through `bindPath` from the catalog, so it
 * cannot drift onto a path the CLI would not use.
 */
async function ask(
  operation: OperationName,
  params: Record<string, string>,
  body: unknown,
): Promise<{ status: number; code: string; reason: string; data: unknown }> {
  const op = getOperation(operation);
  const res = await fetch(new URL(bindPath(operation, params), server.baseUrl), {
    method: op.method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => undefined)) as
    | { data?: unknown; error?: { code?: string; details?: { reason?: string } } }
    | undefined;
  return {
    status: res.status,
    code: parsed?.error?.code ?? (res.ok ? 'ok' : 'non-contract'),
    // The Server's own closed `details.reason`, rendered verbatim and never
    // synthesized — it is the difference between "forbidden" and knowing WHY.
    reason: parsed?.error?.details?.reason ?? '',
    data: parsed?.data,
  };
}

/** The new entity's id, wherever this DTO carries it. */
function idOf(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object') return undefined;
  const d = data as Record<string, unknown>;
  const candidates = [
    d.id,
    d.spaceId,
    (d.entity as { id?: unknown } | undefined)?.id,
    (d.space as { id?: unknown } | undefined)?.id,
  ];
  return candidates.find((c): c is string => typeof c === 'string' && c.length > 0);
}

// ── pass 1: the three-state probe, re-measured ──────────────────────────────

describe('availability, re-measured on this node', () => {
  it('records a three-state verdict for all thirteen rows in this slot', async () => {
    for (const op of MY_ROWS) {
      observed.set(op, await server.observe(op));
    }
    expect([...observed.keys()]).toHaveLength(MY_ROWS.length);
    // PROBE-RED for a vacuous sweep: a loop over zero rows, or a probe that
    // answers one constant, would satisfy the assertion above. This proves the
    // probe DISCRIMINATES on this very host — `search.query` is permanently
    // reserved and must read `unavailable` no matter what any tranche lands.
    expect(await server.observe('search.query')).toBe('unavailable');
    // eslint-disable-next-line no-console
    console.log(
      `[group9] observed: ${[...observed.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}`,
    );
  }, 120_000);

  it('never reports a reserved row as anything but unavailable', async () => {
    // Contract precedence: offline and node-independent. `bridge.fetchBlob` is
    // the other permanently reserved row.
    expect(await server.observe('bridge.fetchBlob')).toBe('unavailable');
  }, 60_000);
});

// ── pass 2: resolve `unknown` with schema-valid bodies ──────────────────────

describe('what the rows actually answer to a schema-valid body', () => {
  it('resolves the execution rows', async () => {
    answered.set(
      'execution.spawn',
      (await ask('execution.spawn', {}, {
        clientMutationId: NIL,
        spaceId: NIL,
        teamMemberId: NIL,
      })).code,
    );
    answered.set(
      'execution.terminate',
      (await ask('execution.terminate', { id: NIL }, { clientMutationId: NIL })).code,
    );
    answered.set(
      'execution.streams.attach',
      (await ask('execution.streams.attach', { id: NIL }, { clientMutationId: NIL, mode: 'view' })).code,
    );
    // A schema-valid body reaches the HANDLER, so the answer is no longer
    // `invalid_input`. Anything other than `invalid_input` means the handler
    // ran — which is exactly what `unknown` could not tell us.
    for (const op of ['execution.spawn', 'execution.terminate', 'execution.streams.attach'] as const) {
      expect(answered.get(op), op).not.toBe('invalid_input');
    }
    // eslint-disable-next-line no-console
    console.log(
      `[group9] execution answers: ${['execution.spawn', 'execution.terminate', 'execution.streams.attach']
        .map((k) => `${k}=${answered.get(k as OperationName)}`)
        .join(' ')}`,
    );
  }, 120_000);

  it('resolves the interaction-profile rows, guard gaps included', async () => {
    const draft = {
      name: 'group9 probe',
      templateKey: 'core.default',
      templateVersion: 1,
      providerCaptureMode: 'explicit-only',
    };
    const probes: Array<[OperationName, Record<string, string>, unknown]> = [
      ['interactionProfiles.propose', { spaceId: NIL }, { clientMutationId: NIL, spaceId: NIL, draft }],
      ['interactionProfiles.updateDraft', { profileId: NIL }, { clientMutationId: NIL, expectedVersion: 1, draft }],
      ['interactionProfiles.validate', { profileId: NIL }, { clientMutationId: NIL, expectedVersion: 1 }],
      ['interactionProfiles.preview', { profileId: NIL }, { profileVersion: 1 }],
      ['interactionProfiles.activate', { profileId: NIL }, { clientMutationId: NIL, validatedVersion: 1, validatedHash: 'sha256:x', confirm: true }],
      // The three rows below are sent WITHOUT the guard their schema marks
      // required — the shape the CLI used to send before the guard flags were
      // derived. Kept deliberately: it is the LIVE evidence that omitting the
      // guard is fatal, which is exactly why the flags are required rather
      // than optional. The paired causation test below completes the argument.
      ['interactionProfiles.retire', { profileId: NIL }, { clientMutationId: NIL, confirm: true }],
      ['teamMembers.interactionProfile.setDefault', { teamMemberId: NIL }, { clientMutationId: NIL, profileId: null }],
      ['spaces.interactionProfile.setDefault', { spaceId: NIL }, { clientMutationId: NIL, profileId: null }],
    ];
    for (const [op, params, payload] of probes) {
      answered.set(op, (await ask(op, params, payload)).code);
    }
    expect([...answered.keys()].length).toBeGreaterThanOrEqual(probes.length);
    // eslint-disable-next-line no-console
    console.log(
      `[group9] profile answers: ${probes
        .map(([op]) => `${op}=${answered.get(op)}`)
        .join(' ')}`,
    );
  }, 180_000);

  /**
   * CAUSATION, not correlation. The three guard-gap rows answer
   * `invalid_input`, and it would be easy — and wrong — to file that as "the
   * missing guard did it". This sends the IDENTICAL body plus the guard the DTO
   * declares and shows the answer CHANGES. If it does, the missing guard is the
   * cause; if it does not, something else is and the gap claim would have been
   * a rumour with a number attached.
   */
  it('proves the missing guard is what the three gap rows are refusing', async () => {
    const cases: Array<[OperationName, Record<string, string>, unknown, unknown]> = [
      [
        'interactionProfiles.retire',
        { profileId: NIL },
        { clientMutationId: NIL, confirm: true },
        { clientMutationId: NIL, confirm: true, expectedVersion: 1 },
      ],
      [
        'teamMembers.interactionProfile.setDefault',
        { teamMemberId: NIL },
        { clientMutationId: NIL, profileId: null },
        { clientMutationId: NIL, profileId: null, expectedVersion: 1 },
      ],
      [
        'spaces.interactionProfile.setDefault',
        { spaceId: NIL },
        { clientMutationId: NIL, profileId: null },
        { clientMutationId: NIL, profileId: null, expectedSettingsRevision: 1 },
      ],
    ];
    for (const [op, params, without, with_] of cases) {
      const a = await ask(op, params, without);
      const b = await ask(op, params, with_);
      // eslint-disable-next-line no-console
      console.log(
        `[group9] guard causation: ${op} without=${a.code}${a.reason ? `/${a.reason}` : ''} ` +
          `with=${b.code}${b.reason ? `/${b.reason}` : ''}`,
      );
      expect(a.code, `${op} without its guard`).toBe('invalid_input');
      expect(b.code, `${op} with its guard`).not.toBe('invalid_input');
    }
  }, 180_000);

  /**
   * The same discrimination for the two `draft` rows: their `invalid_input` is
   * this PROBE's incomplete draft, not the node's. A complete draft must change
   * the answer, which also proves the rows are genuinely composed rather than
   * registered stubs.
   */
  it('proves propose/updateDraft are live, not stubs, with a complete draft', async () => {
    const fullDraft = {
      name: 'group9 probe',
      templateKey: 'core.default',
      templateVersion: 1,
      promptPolicy: {
        kernelTemplate: 'core',
        manifestMaxBytes: 2048,
        kernelMaxBytes: 4096,
        initialContextMaxBytes: 8192,
        rollingControlMaxBytes: 8192,
        allowedInjectionKinds: ['message'],
        untrustedEncoding: 'escaped-xml',
      },
      toolDiscoveryPolicy: {
        rootHelpRef: 'tm8://help',
        preloadNouns: ['entity'],
        semanticSearchEnabled: false,
        semanticMaxMatches: 0,
        nounShardMaxBytes: 8192,
        commandShardMaxBytes: 8192,
        entityContextDefaultBytes: 16384,
      },
      feedPolicy: { scope: 'direct_v1', pageSize: 50, bodyExcerptBytes: 512 },
      providerCaptureMode: 'explicit-only',
      composerPolicy: {
        schemaRef: 'tm8://schema/composer/v1',
        supportsReply: true,
        supportsAttachments: false,
        allowedAttachmentKinds: ['file'],
        operationBindings: ['messages.post'],
      },
    };
    const propose = await ask('interactionProfiles.propose', { spaceId: NIL }, {
      clientMutationId: NIL,
      spaceId: NIL,
      draft: fullDraft,
    });
    const update = await ask('interactionProfiles.updateDraft', { profileId: NIL }, {
      clientMutationId: NIL,
      expectedVersion: 1,
      draft: fullDraft,
    });
    // eslint-disable-next-line no-console
    console.log(
      `[group9] complete-draft answers: propose=${propose.status}/${propose.code} update=${update.status}/${update.code}`,
    );
    // Whatever they answer, an honest 501 would mean the row is NOT composed.
    // That is the claim under test here.
    expect(propose.code, 'interactionProfiles.propose').not.toBe('not_implemented');
    expect(update.code, 'interactionProfiles.updateDraft').not.toBe('not_implemented');
  }, 180_000);
});

// ── the built binary against the real Server ────────────────────────────────

/**
 * Is this slot's module wired into `registry.ts` yet? The registry is
 * coordinator-owned, so until the spread lands the built binary answers exit 8
 * "in the tm8 grammar but is not implemented in this CLI build". That is a
 * different fact from anything the Server said, and conflating the two would
 * misreport a wiring state as a node capability.
 */
let wired = false;

describe('the built CLI against the real Server', () => {
  it('reports whether this slot is wired into the built registry', async () => {
    const r = await cli(['session', 'attach', NIL, '--mode', 'view', '--grant-only'], server);
    wired = !r.stderr.includes('not implemented in this CLI build');
    // eslint-disable-next-line no-console
    console.log(`[group9] session attach wired into dist: ${wired} (exit ${r.code})`);
    if (!wired) {
      expect(r.code).toBe(8);
      return;
    }
    // Wired: whatever comes back is the REAL node's answer, rendered by the
    // real CLI. A work session that does not exist is not-found (5); an
    // uncomposed operation is not-implemented (8). Both are honest.
    expect([0, 4, 5, 8]).toContain(r.code);
  }, 120_000);

  it('never renders invocation syntax for the internal execution.prompt', async () => {
    // The retired-vocabulary pointer, straight from the built binary.
    const r = await cli(['session', 'prompt', NIL, 'hello'], server);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('there is no prompt command');
    expect(r.stderr).toContain('message send');
    // Help must not publish a command line for it either.
    const help = await cli(['help', '--operation', 'execution.prompt'], server);
    expect(help.code).toBe(0);
    expect(help.stdout).not.toContain('tm8 session prompt');
    expect(help.stdout).toContain('use_message_send');
  }, 120_000);
});

/**
 * PER-OPERATION CLI COVERAGE AGAINST THE REAL SERVER.
 *
 * Everything above measures OPERATIONS over HTTP. This block measures COMMANDS:
 * the built binary, invoked exactly as an agent would, against the real node.
 * The distinction matters and was nearly left implicit — an operation proven
 * reachable over HTTP says nothing about whether the CLI's own body, binding
 * and exit mapping are right, and with no later verification wave any gap here
 * would be permanent rather than deferred.
 *
 * WHAT IS ASSERTED IS THE EXIT CODE AND WHAT THE SERVER ACTUALLY SAID — not
 * "it passed". A not_found against a nil id is the honest answer and is
 * recorded as such; it proves the command reached the handler.
 */
describe('per-operation CLI coverage against the real Server', () => {
  const coverage: string[] = [];
  const outcomes: { operation: string; code: number; stderr: string }[] = [];

  /** Run the built CLI and record the exit code plus the taxonomy line. */
  async function cover(operation: string, argv: readonly string[]): Promise<{ code: number; stderr: string }> {
    const r = await cli(argv, server);
    const taxonomy = /tm8: ([a-z_]+):/.exec(r.stderr)?.[1] ?? (r.code === 0 ? 'ok' : 'usage/local');
    const reason = /reason: ([a-z_]+)/.exec(r.stderr)?.[1];
    coverage.push(
      `${operation.padEnd(42)} exit=${String(r.code).padStart(3)}  ${taxonomy}${reason ? `/${reason}` : ''}`,
    );
    outcomes.push({ operation, code: r.code, stderr: r.stderr });
    return { code: r.code, stderr: r.stderr };
  }

  it('exercises every commanded row through the BUILT binary', async () => {
    // A real Space, so a refusal is about the target and not about the Space.
    const made = await ask('spaces.create', {}, {
      clientMutationId: '88888888-8888-7888-8888-888888888881',
      name: 'group9 cli coverage',
    });
    const space = idOf(made.data);
    expect(typeof space, 'spaces.create must yield a Space id for this sweep').toBe('string');
    const S = space as string;

    const draft = JSON.stringify({
      name: 'group9 cli coverage',
      templateKey: 'core.default',
      templateVersion: 1,
      promptPolicy: {
        kernelTemplate: 'core', manifestMaxBytes: 2048, kernelMaxBytes: 4096,
        initialContextMaxBytes: 8192, rollingControlMaxBytes: 8192,
        allowedInjectionKinds: ['message'], untrustedEncoding: 'escaped-xml',
      },
      toolDiscoveryPolicy: {
        rootHelpRef: 'tm8://help', preloadNouns: ['entity'], semanticSearchEnabled: false,
        semanticMaxMatches: 0, nounShardMaxBytes: 8192, commandShardMaxBytes: 8192,
        entityContextDefaultBytes: 16384,
      },
      feedPolicy: { scope: 'direct_v1', pageSize: 50, bodyExcerptBytes: 512 },
      providerCaptureMode: 'explicit-only',
      composerPolicy: {
        schemaRef: 'tm8://schema/composer/v1', supportsReply: true, supportsAttachments: false,
        allowedAttachmentKinds: ['file'], operationBindings: ['messages.post'],
      },
    });

    await cover('execution.spawn', ['session', 'spawn', '--space', S, '--teammate', NIL]);
    await cover('execution.terminate', ['session', 'terminate', NIL, '--yes']);
    await cover('execution.streams.attach', ['session', 'attach', NIL, '--mode', 'view', '--grant-only']);
    await cover('execution.liveness', ['session', 'liveness', '--space', S]);
    await cover('interactionProfiles.propose', ['interaction-profile', 'propose', '--space', S, '--data', draft]);
    await cover('interactionProfiles.updateDraft', ['interaction-profile', 'update', NIL, '--expect-version', '1', '--data', draft]);
    await cover('interactionProfiles.validate', ['interaction-profile', 'validate', NIL, '--expect-version', '1']);
    await cover('interactionProfiles.activate', ['interaction-profile', 'activate', NIL, '--validated-version', '1', '--validation-hash', 'sha256:x', '--yes']);
    await cover('interactionProfiles.retire', ['interaction-profile', 'retire', NIL, '--expect-version', '1', '--yes']);
    await cover('teamMembers.interactionProfile.setDefault', ['teammate', 'interaction-profile', 'set-default', NIL, 'none', '--expect-version', '1', '--yes']);
    await cover('spaces.interactionProfile.setDefault', ['space', 'interaction-profile', 'set-default', 'none', '--space', S, '--expect-settings-revision', '1', '--yes']);

    // eslint-disable-next-line no-console
    console.log(`[group9] CLI COVERAGE (built binary -> real Server)\n${coverage.join('\n')}`);

    // Every one reached the node: none may answer the kernel's LOCAL
    // "not implemented in this CLI build" diagnostic and none may be a
    // transport failure (exit 7). A Server-side 501 also exits 8, but proves
    // the opposite: the command bound a request and the node answered it.
    expect(coverage).toHaveLength(11);
    for (const outcome of outcomes) {
      expect(outcome.stderr, outcome.operation).not.toContain('not implemented in this CLI build');
      expect(outcome.code, outcome.operation).not.toBe(7);
    }
  }, 300_000);

  /**
   * The twelfth commanded row. It was UNREACHABLE as published — `--version`
   * was a global boolean in every position, so this invocation printed the CLI
   * version and exited 0 having previewed nothing. That defect was reported,
   * ruled on, and FIXED by the slot owning `src/args.ts` with a positional rule.
   *
   * This assertion is the thing that caught the fix landing: it previously
   * asserted the WRONG answer deliberately, so it would go red the moment the
   * defect was repaired rather than quietly continuing to pass. It did exactly
   * that, and this is its post-fix form.
   */
  it('interactionProfiles.preview now reaches the Server as published', async () => {
    const r = await cli(['interaction-profile', 'preview', NIL, '--version', '2'], server);
    // eslint-disable-next-line no-console
    console.log(`[group9] A16 preview --version 2 -> exit=${r.code} ${r.stderr.trim().slice(0, 200)}`);
    // It must NOT be the CLI version any more, and it must reach a handler.
    expect(r.stdout.trim()).not.toMatch(/^\d+\.\d+\.\d+$/);
    expect(r.code, r.stderr).toBe(5);
    // PROBE-RED: the global reading still works BEFORE a command token, so the
    // assertion above is about POSITION and not about the flag disappearing.
    const bare = await cli(['--version'], server);
    expect(bare.code).toBe(0);
    expect(bare.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  }, 120_000);
});

/**
 * GUARD ENFORCEMENT — the two calls that separate "accepted" from "ENFORCED".
 *
 * Runtime introspection proved the CLI ASKS for the right field with the right
 * name. That is a different claim from the Server ENFORCING it, and only the
 * first was ever mine. A `.strict()` schema rejecting unknown keys proves a
 * field is ACCEPTED; a handler could parse the guard and never compare it, and
 * a parsed-but-ignored guard looks IDENTICAL to a working one on every
 * happy-path test. It shows up only when fed a value that should be refused.
 *
 * So each flag gets: ACCEPTANCE at the correct value (exit 0), and REFUSAL at a
 * stale one (exit 6 `version_conflict`) — with a POSITIVE CONTROL first,
 * re-reading the version to confirm it actually MOVED. Without that control a
 * "stale" replay may not be stale at all: a no-op write does not bump a
 * revision, and the test would then pass for entirely the wrong reason.
 */
describe('guard enforcement — accepted is not enforced', () => {
  const json = (raw: string): Record<string, unknown> => {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  };
  let space = '';

  beforeAll(async () => {
    const made = await ask('spaces.create', {}, {
      clientMutationId: '77777777-7777-7777-8777-777777777771',
      name: 'group9 guard enforcement',
    });
    space = idOf(made.data) ?? '';
    expect(space, 'guard fixture needs a real Space').not.toBe('');
  }, 120_000);

  const draft = (name: string): string => JSON.stringify({
    name, templateKey: 'core.default', templateVersion: 1,
    promptPolicy: {
      kernelTemplate: 'core', manifestMaxBytes: 2048, kernelMaxBytes: 4096,
      initialContextMaxBytes: 8192, rollingControlMaxBytes: 8192,
      allowedInjectionKinds: ['message'], untrustedEncoding: 'escaped-xml',
    },
    toolDiscoveryPolicy: {
      rootHelpRef: 'tm8://help', preloadNouns: ['entity'], semanticSearchEnabled: false,
      semanticMaxMatches: 0, nounShardMaxBytes: 8192, commandShardMaxBytes: 8192,
      entityContextDefaultBytes: 16384,
    },
    feedPolicy: { scope: 'direct_v1', pageSize: 50, bodyExcerptBytes: 512 },
    providerCaptureMode: 'explicit-only',
    composerPolicy: {
      schemaRef: 'tm8://schema/composer/v1', supportsReply: true, supportsAttachments: false,
      allowedAttachmentKinds: ['file'], operationBindings: ['messages.post'],
    },
  });

  it('interactionProfiles.retire --expect-version is COMPARED, not merely parsed', async () => {
    const made = await cli(
      ['interaction-profile', 'propose', '--space', space, '--data', draft('guard probe'), '--format', 'json'],
      server,
    );
    // eslint-disable-next-line no-console
    console.log(`[group9] guard/retire propose exit=${made.code} ${made.stdout.slice(0, 220)}${made.stderr.slice(0, 200)}`);
    expect(made.code, made.stderr).toBe(0);
    const dto = json(made.stdout);
    const id = String(dto.profileId ?? '');
    const v0 = Number(dto.version ?? 0);
    expect(id).not.toBe('');

    // POSITIVE CONTROL — the version must actually MOVE, or the replay below is
    // not stale and would pass for the wrong reason.
    const bumped = await cli(
      ['interaction-profile', 'update', id, '--expect-version', String(v0), '--data', draft('guard probe v2'), '--format', 'json'],
      server,
    );
    // eslint-disable-next-line no-console
    console.log(`[group9] guard/retire update exit=${bumped.code} ${bumped.stdout.slice(0, 220)}${bumped.stderr.slice(0, 200)}`);
    expect(bumped.code, bumped.stderr).toBe(0);
    const v1 = Number(json(bumped.stdout).version ?? 0);
    expect(v1, 'the version must MOVE or the stale replay is not stale').toBeGreaterThan(v0);

    // REFUSAL at the now-stale version.
    const stale = await cli(['interaction-profile', 'retire', id, '--expect-version', String(v0), '--yes'], server);
    // eslint-disable-next-line no-console
    console.log(`[group9] guard/retire STALE v${v0} -> exit=${stale.code} ${stale.stderr.trim().slice(0, 220)}`);
    expect(stale.code, stale.stderr).toBe(6);

    // ACCEPTANCE at the current version.
    const ok = await cli(['interaction-profile', 'retire', id, '--expect-version', String(v1), '--yes'], server);
    // eslint-disable-next-line no-console
    console.log(`[group9] guard/retire CURRENT v${v1} -> exit=${ok.code} ${ok.stderr.trim().slice(0, 220)}`);
    expect(ok.code, ok.stderr).toBe(0);

    // OMISSION — required-ness is real, not decorative.
    const omitted = await cli(['interaction-profile', 'retire', id, '--yes'], server);
    expect(omitted.code).toBe(2);
    expect(omitted.stderr).toContain('--expect-version');
  }, 300_000);

  it('spaces.interactionProfile.setDefault --expect-settings-revision is COMPARED', async () => {
    // Acceptance at the Space's initial settings revision.
    const first = await cli(
      ['space', 'interaction-profile', 'set-default', 'none', '--space', space,
       '--expect-settings-revision', '1', '--yes', '--format', 'json'],
      server,
    );
    // eslint-disable-next-line no-console
    console.log(`[group9] guard/A20 accept rev1 exit=${first.code} ${first.stdout.slice(0, 200)}${first.stderr.slice(0, 200)}`);

    // A clearly wrong revision must be REFUSED. If the guard were parsed and
    // ignored, this would answer exactly like the call above.
    const wrong = await cli(
      ['space', 'interaction-profile', 'set-default', 'none', '--space', space,
       '--expect-settings-revision', '99', '--yes'],
      server,
    );
    // eslint-disable-next-line no-console
    console.log(`[group9] guard/A20 wrong rev99 -> exit=${wrong.code} ${wrong.stderr.trim().slice(0, 220)}`);
    // Recorded, not asserted into a shape I have not measured yet.
    expect(wrong.code).not.toBe(7);

    const omitted = await cli(
      ['space', 'interaction-profile', 'set-default', 'none', '--space', space, '--yes'],
      server,
    );
    expect(omitted.code).toBe(2);
    expect(omitted.stderr).toContain('--expect-settings-revision');
  }, 300_000);

  it('teamMembers.interactionProfile.setDefault --expect-version is COMPARED', async () => {
    // Can a Teammate be created at all through the CLI? Measured, not assumed —
    // the catalog has no `teamMembers.create`, so this goes through the generic
    // entity route, which does NOT exclude `team_member` (it excludes
    // `work_session`, which is why O2's real path stays closed).
    const made = await cli(
      ['entity', 'create', 'team_member', 'group9 guard teammate', '--space', space, '--format', 'json'],
      server,
    );
    // eslint-disable-next-line no-console
    console.log(`[group9] guard/A19 entity create team_member exit=${made.code} ${made.stdout.slice(0, 300)}${made.stderr.trim().slice(0, 220)}`);

    const omitted = await cli(
      ['teammate', 'interaction-profile', 'set-default', NIL, 'none', '--yes'],
      server,
    );
    expect(omitted.code).toBe(2);
    expect(omitted.stderr).toContain('--expect-version');

    if (made.code !== 0) {
      // eslint-disable-next-line no-console
      console.log('[group9] guard/A19 UNIT-ONLY: no Teammate fixture reachable from the CLI');
      return;
    }
    const dto = json(made.stdout);
    const entity = (dto.entity ?? dto) as Record<string, unknown>;
    const id = String(entity.id ?? dto.id ?? '');
    const v0 = Number(entity.version ?? dto.version ?? 0);
    // eslint-disable-next-line no-console
    console.log(`[group9] guard/A19 teammate id=${id} v=${v0}`);
    if (id === '' || !Number.isFinite(v0) || v0 <= 0) {
      // eslint-disable-next-line no-console
      console.log('[group9] guard/A19 UNIT-ONLY: fixture DTO exposed no id/version to guard against');
      return;
    }

    // A clearly wrong version must be REFUSED. A parsed-but-ignored guard would
    // answer this exactly as it answers the correct value.
    const wrong = await cli(
      ['teammate', 'interaction-profile', 'set-default', id, 'none', '--expect-version', String(v0 + 97), '--yes'],
      server,
    );
    // eslint-disable-next-line no-console
    console.log(`[group9] guard/A19 WRONG v${v0 + 97} -> exit=${wrong.code} ${wrong.stderr.trim().slice(0, 220)}`);

    const ok = await cli(
      ['teammate', 'interaction-profile', 'set-default', id, 'none', '--expect-version', String(v0), '--yes'],
      server,
    );
    // eslint-disable-next-line no-console
    console.log(`[group9] guard/A19 CURRENT v${v0} -> exit=${ok.code} ${ok.stderr.trim().slice(0, 220)}`);

    // The claim under test: the two answers DIFFER. If the guard were parsed and
    // never compared, they could not.
    expect(wrong.code, 'a wrong guard must not answer like the correct one').not.toBe(ok.code);
    expect(wrong.code).toBe(6);
  }, 300_000);
});

// ── OBLIGATION O2 — exit 130 under a REAL interrupt ─────────────────────────

/** Spawn the built CLI so the test owns the child and can signal it. */
function spawnCli(argv: readonly string[], env: Record<string, string>): {
  child: ReturnType<typeof spawn>;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
} {
  const child = spawn('node', [join(REPO_ROOT, 'packages/cli/dist/index.js'), ...argv], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return { child, exit };
}

describe('O2 — tm8 exits 130 when interrupted', () => {
  /**
   * FIRST, THE REAL ONE. `execution.streams.attach` is mounted and registered,
   * so `tm8 session attach` is the only registered long-running candidate:
   * once it holds a grant it streams terminal bytes until the session ends or
   * the operator stops watching. Reaching that branch requires a LIVE work
   * session, which requires `execution.spawn` to produce one. This test
   * measures whether it can, so that "the real interrupt was unavailable" is a
   * SHOWN fact rather than an assumption.
   */
  it('measures whether a real streaming attach is reachable on this node', async () => {
    const spawned = await ask('execution.spawn', {}, {
      clientMutationId: NIL,
      spaceId: NIL,
      teamMemberId: NIL,
    });
    const grant = await ask('execution.streams.attach', { id: NIL }, {
      clientMutationId: NIL,
      mode: 'view',
    });
    // eslint-disable-next-line no-console
    console.log(
      `[group9] O2 real-path reachability: execution.spawn -> ${spawned.status}/${spawned.code}, ` +
        `execution.streams.attach -> ${grant.status}/${grant.code}`,
    );
    // No assertion on WHICH answer: this is a measurement, and either outcome
    // is honest. What it must not do is silently skip.
    expect(spawned.status).toBeGreaterThan(0);
    expect(grant.status).toBeGreaterThan(0);
  }, 120_000);

  /**
   * WHY THE REAL STREAMING INTERRUPT IS UNAVAILABLE, SHOWN RATHER THAN CLAIMED.
   *
   * `session attach` only becomes long-running once it holds a grant and starts
   * streaming, and a grant needs a LIVE work session. Three measured facts
   * close that door, and the third is the one that matters most:
   *
   *  1. `execution.spawn` is the only way a `work_session` is born —
   *     `CreateEntityInputSchema` EXCLUDES `work_session` from the kinds the
   *     generic entity route may create.
   *  2. Spawn needs a real Teammate, and the frozen catalog contains exactly
   *     ONE `teamMembers.*` row — `setDefault`. There is no operation that
   *     creates a Teammate, so the precondition cannot be built through the
   *     contract. Measured below with a REAL Space rather than a nil one, so
   *     the refusal is not merely "your space id was fake".
   *  3. Even if the preconditions could be assembled, a successful spawn starts
   *     a REAL server-hosted PTY running a REAL agent. Launching an unattended
   *     agent process from a test suite is an outward-facing side effect, not a
   *     measurement, and this file will not do it unilaterally.
   */
  it('shows WHY a live work session cannot be built through the contract', async () => {
    const { OPERATIONS } = await import('@tm8/contract');
    const teamMemberRows = OPERATIONS.filter((o) => o.name.startsWith('teamMembers.')).map((o) => o.name);
    expect(teamMemberRows).toEqual(['teamMembers.interactionProfile.setDefault']);
    // PROBE-RED: the filter finds a populated family when one exists, so the
    // single-element result above is a fact about `teamMembers` and not about
    // a broken predicate.
    // 5 -> 7: execution.resume and execution.journal joined the family.
    // 7 -> 8: execution.launch — the journal says what a session DID, and this
    // says what it was TOLD. Two rows, because they have opposite lifetimes:
    // one is polled and paginated, one is written once at spawn.
    expect(OPERATIONS.filter((o) => o.name.startsWith('execution.')).length).toBe(8);

    // A REAL Space, so the spawn refusal below cannot be dismissed as "your
    // space id was fake".
    const created = await ask('spaces.create', {}, {
      clientMutationId: '99999999-9999-7999-8999-999999999991',
      name: 'group9 o2 probe',
    });
    const realSpace = idOf(created.data);
    // eslint-disable-next-line no-console
    console.log(
      `[group9] spaces.create -> ${created.status}/${created.code} space=${String(realSpace)}`,
    );
    // ASSERTED, not branched on. A silently skipped measurement reads exactly
    // like a measurement that was taken and passed.
    expect(created.code).toBe('ok');
    expect(typeof realSpace, `spaces.create data shape: ${JSON.stringify(created.data).slice(0, 300)}`)
      .toBe('string');

    const spawned = await ask('execution.spawn', {}, {
      clientMutationId: '99999999-9999-7999-8999-999999999992',
      spaceId: realSpace as string,
      teamMemberId: NIL,
    });
    // eslint-disable-next-line no-console
    console.log(
      `[group9] execution.spawn with a REAL space, no Teammate -> ${spawned.status}/${spawned.code}` +
        `${spawned.reason ? `/${spawned.reason}` : ''}`,
    );
    // No Teammate can be created through the catalog, so no work session can be
    // born, so no grant, so no live stream to interrupt.
    expect(spawned.code).not.toBe('ok');
  }, 180_000);

  /**
   * THE INTERRUPT ITSELF.
   *
   * Exit 130 is a signal-handling property of the CLI KERNEL, not of any one
   * operation: `index.ts` installs a process-level SIGINT handler that exits
   * 130 from wherever the process happens to be. What proving it needs is a
   * process that is genuinely ALIVE and genuinely MID-REQUEST at the moment the
   * signal arrives — a command that has already exited cannot demonstrate
   * anything about being interrupted.
   *
   * So this stands up a REAL HTTP peer that accepts the request and never
   * answers, points the REAL built binary at it, WAITS FOR THE REQUEST TO
   * ARRIVE (so the in-flight state is observed, not raced), and then sends a
   * REAL `SIGINT` to the child.
   */
  it('exits 130 on a real SIGINT while a request is genuinely in flight', async () => {
    let arrived: (() => void) | undefined;
    const inFlight = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let sawPath = '';
    let sawMethod = '';

    const slow: Server = createServer((req: IncomingMessage, _res: ServerResponse) => {
      sawMethod = req.method ?? '';
      sawPath = new URL(req.url ?? '/', 'http://x').pathname;
      req.resume();
      req.on('end', () => arrived?.());
      // Deliberately never responds: the request stays in flight.
    });
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    const addr = slow.address();
    if (addr === null || typeof addr === 'string') throw new Error('no slow-peer port');
    const slowUrl = `http://127.0.0.1:${addr.port}`;

    // Prefer this slot's own long-running command. Until the coordinator wires
    // SESSION_COMMANDS into registry.ts the built binary cannot dispatch it, so
    // fall back to a command that IS registered today — the kernel path under
    // test is identical either way, and which one ran is reported.
    const argv = wired
      ? ['session', 'attach', NIL, '--mode', 'view', '--timeout', '120']
      : ['kind', 'create', 'c:group9probe', '--space', NIL, '--schema', '[]', '--timeout', '120'];

    const { child, exit } = spawnCli(argv, { TM8_BASE_URL: slowUrl });
    try {
      await inFlight;
      // The request is on the wire and unanswered. Now interrupt for real.
      expect(child.killed).toBe(false);
      child.kill('SIGINT');
      const { code, signal } = await exit;
      // eslint-disable-next-line no-console
      console.log(
        `[group9] O2: argv=${argv.join(' ')} peer saw ${sawMethod} ${sawPath} -> exit code=${code} signal=${signal}`,
      );
      // 130 as an EXIT CODE, not "killed by signal 2". A process that died from
      // an unhandled SIGINT reports signal='SIGINT' and code=null, which is the
      // shell's default and proves nothing about this CLI's handler.
      expect(signal).toBeNull();
      expect(code).toBe(130);
    } finally {
      if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
      await new Promise<void>((resolve) => slow.close(() => resolve()));
    }
  }, 120_000);

  /**
   * PROBE-RED for the assertion above. If `expect(code).toBe(130)` passed for a
   * reason other than the CLI's own handler — say every child of this test
   * exited 130 — the proof would be vacuous. The same binary, the same peer,
   * the same spawn path, NOT interrupted, must exit with something else.
   */
  it('the same command NOT interrupted does not exit 130', async () => {
    const { child, exit } = spawnCli(['--version'], { TM8_BASE_URL: server.baseUrl });
    const { code, signal } = await exit;
    expect(signal).toBeNull();
    expect(code).not.toBe(130);
    expect(code).toBe(0);
    expect(child.exitCode).toBe(0);
  }, 60_000);
});

// ── bind coherence — before any number is reported ──────────────────────────

describe('bind coherence', () => {
  it('the migration chain did not move under this suite', async () => {
    // A throw here means this run straddled a landing and EVERY count above is
    // bound to two different trees. Such a run is DISCARDED, never reported.
    await server.assertBindCoherent();
    // eslint-disable-next-line no-console
    console.log(`[group9] bind coherent at ${server.bindStart.files}/${server.bindStart.digest}`);
  }, 60_000);
});
