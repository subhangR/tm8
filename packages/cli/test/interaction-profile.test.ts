/**
 * `tm8 interaction-profile …` (A13–A18) and BOTH profile-default commands
 * (A19 `teammate interaction-profile set-default`, A20 `space
 * interaction-profile set-default`).
 *
 * SEAM RULING S3 IS ASSERTED HERE, NOT ASSUMED. A20 sits under the `space`
 * noun, which another slot owns, but a *module* is the ownership unit and a
 * symmetric pair split across two modules is exactly the drift module ownership
 * exists to prevent. The consequence of getting it wrong is not one red test:
 * `registry.ts` throws on a duplicate path at IMPORT, so a double registration
 * collapses the entire suite for every slot at once. The cross-module check
 * below therefore reads the other slot's exported array and proves the row
 * appears exactly once across both.
 *
 * A17–A20 REQUIRE A HUMAN MEMBER OWNER/ADMIN PRINCIPAL, and the CLI cannot
 * transmit anything else: `ActivateInteractionProfileInput`,
 * `RetireInteractionProfileInput`, `SetTeammateProfileDefaultInput` and
 * `SetSpaceProfileDefaultInput` are `.strict()` and declare NO `actorId`. So an
 * explicit `--as` or a present agent token is refused before the wire with the
 * contract's own closed reason, `profile_principal_required` — the alternative
 * is dropping the caller's chosen author in silence and writing as somebody
 * they did not select. `execution.spawn` is deliberately NOT treated this way:
 * its DTO does carry `actorId`, so the Server can see the selection and remains
 * the authority.
 *
 * MEASURED, NOT ASSUMED: these rows were briefed as G12/G14 residual answering
 * an honest 501. They are NOT — a tranche composed them, and
 * `test/integration/session.test.ts` re-derives the availability column from
 * what the node actually answers rather than from any description of it. The
 * bindings below are asserted against a LOCAL STUB so they hold either way,
 * which is the point: a binding test that depended on composition state would
 * be measuring the Server, not the CLI.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { parseInvocation, splitCommandPath } from '../src/args.js';
import { loadLocalConfig, resolveContext, sessionContextFromEnv } from '../src/context.js';
import { errorLines, exitCodeFor } from '../src/errors.js';
import { UUID_PATTERN } from '../src/mutation.js';
import { createOutput } from '../src/output.js';
import { isCommandPath } from '../src/discovery/operations.js';
import type { CommandModule } from '../src/run.js';

/** Imported lazily so a missing module fails each TEST, not only the FILE. */
async function profileCommands(): Promise<CommandModule[]> {
  const mod = await import('../src/commands/interaction-profile.js');
  const defaults = await import('../src/commands/teammate.js');
  return [...mod.INTERACTION_PROFILE_COMMANDS, ...defaults.PROFILE_DEFAULT_COMMANDS];
}

// ── the stub Server ─────────────────────────────────────────────────────────

interface Seen {
  method: string;
  pathname: string;
  body: unknown;
}

let server: Server;
let baseUrl: string;
let seen: Seen[] = [];
let reply: { status: number; body: unknown } = {
  status: 200,
  body: { data: {}, requestId: 'req_t' },
};

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const raw = Buffer.concat(chunks).toString('utf8');
      seen.push({
        method: req.method ?? '',
        pathname: url.pathname,
        body: raw ? (JSON.parse(raw) as unknown) : undefined,
      });
      res.setHeader('content-type', 'application/json');
      res.statusCode = reply.status;
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no stub port');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
  reply = { status: 200, body: { data: {}, requestId: 'req_t' } };
});

const SAVED = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
});

interface DriveResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function drive(
  argv: readonly string[],
  session: Record<string, string> = {},
): Promise<DriveResult> {
  const modules = await profileCommands();
  const out: string[] = [];
  const err: string[] = [];
  const streams = {
    stdout: (chunk: string | Uint8Array) =>
      void out.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')),
    stderr: (chunk: string) => void err.push(chunk),
  };

  let output = createOutput({ format: 'human', streams });
  try {
    const invocation = parseInvocation(argv);
    output = createOutput({
      format: invocation.globals.format,
      color: invocation.globals.color,
      quiet: invocation.globals.quiet,
      streams,
    });
    const registered = new Map(modules.map((m) => [m.path.join(' '), m]));
    const match = splitCommandPath(invocation.positionals, (p) => registered.has(p.join(' ')));
    if (!match) throw new Error(`no group-9 command matched: ${invocation.positionals.join(' ')}`);
    const command = registered.get(match.path.join(' '))!;
    const ctx = resolveContext({
      globals: invocation.globals,
      session: sessionContextFromEnv({ TM8_BASE_URL: baseUrl, ...session }),
      config: loadLocalConfig({}, {
        readFile: () => {
          throw new Error('no config in a group-9 test');
        },
      }),
    });
    const code = await command.run({
      path: match.path,
      args: match.args,
      options: invocation.options,
      passthrough: invocation.passthrough,
      ctx,
      out: output,
    });
    return { code, stdout: out.join(''), stderr: err.join('') };
  } catch (error) {
    output.error(errorLines(error));
    return { code: exitCodeFor(error), stdout: out.join(''), stderr: err.join('') };
  }
}

const SPACE = '11111111-1111-7111-8111-111111111111';
const PROFILE = '44444444-4444-7444-8444-444444444444';
const TEAMMATE = '22222222-2222-7222-8222-222222222222';
const DRAFT = JSON.stringify({
  name: 'reviewer',
  templateKey: 'core.reviewer',
  templateVersion: 1,
  providerCaptureMode: 'explicit-only',
});
const body = (): Record<string, unknown> => (seen[0]?.body ?? {}) as Record<string, unknown>;
const keys = (): string[] => Object.keys(body()).sort();

// ── registration and seam ruling S3 ─────────────────────────────────────────

describe('registration', () => {
  it('registers the six lifecycle rows and both default rows, once each', async () => {
    const paths = (await profileCommands()).map((m) => m.path.join(' ')).sort();
    expect(paths).toEqual([
      'interaction-profile activate',
      'interaction-profile preview',
      'interaction-profile propose',
      'interaction-profile retire',
      'interaction-profile update',
      'interaction-profile validate',
      'space interaction-profile set-default',
      'teammate interaction-profile set-default',
    ]);
  });

  it('every registered path is in the frozen projection', async () => {
    for (const m of await profileCommands()) {
      expect(isCommandPath(m.path), m.path.join(' ')).toBe(true);
    }
    // PROBE-RED: the sweep is worthless if the predicate says yes to anything.
    expect(isCommandPath(['interaction-profile', 'delete'])).toBe(false);
  });

  it('S3: `space interaction-profile set-default` is registered HERE and NOT by the space module', async () => {
    const mine = (await import('../src/commands/teammate.js')).PROFILE_DEFAULT_COMMANDS
      .map((m) => m.path.join(' '));
    const theirs = (await import('../src/commands/space.js')).SPACE_COMMANDS
      .map((m) => m.path.join(' '));
    expect(mine).toContain('space interaction-profile set-default');
    expect(theirs).not.toContain('space interaction-profile set-default');
    // PROBE-RED: the other module IS populated and DOES own `space` rows, so
    // the negative above is a fact about one path rather than an empty array.
    expect(theirs).toContain('space list');
    // A duplicate across the two arrays is what `registry.ts` throws on at
    // import — which would collapse every slot's suite at once, not one test.
    expect(mine.filter((p) => theirs.includes(p))).toEqual([]);
  });
});

// ── A13 propose ─────────────────────────────────────────────────────────────

describe('interaction-profile propose', () => {
  it('binds interactionProfiles.propose under the Space', async () => {
    const r = await drive(['interaction-profile', 'propose', '--space', SPACE, '--data', DRAFT]);
    expect(r.code).toBe(0);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.pathname).toBe(`/v2/spaces/${SPACE}/interaction-profiles`);
    expect(keys()).toEqual(['clientMutationId', 'draft', 'spaceId']);
    expect(body().spaceId).toBe(SPACE);
    expect(body().draft).toEqual(JSON.parse(DRAFT));
    expect(String(body().clientMutationId)).toMatch(UUID_PATTERN);
  });

  it('requires --data', async () => {
    const r = await drive(['interaction-profile', 'propose', '--space', SPACE]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--data');
    expect(seen).toEqual([]);
  });

  it('refuses invalid JSON locally, without sending it', async () => {
    const r = await drive(['interaction-profile', 'propose', '--space', SPACE, '--data', '{nope']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('invalid JSON source');
    expect(seen).toEqual([]);
  });

  it('requires a Space in context', async () => {
    const r = await drive(['interaction-profile', 'propose', '--data', DRAFT]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('no Space in context');
    expect(seen).toEqual([]);
  });

  it('refuses --as: the frozen DTO declares no author field', async () => {
    const r = await drive([
      'interaction-profile', 'propose', '--space', SPACE, '--data', DRAFT, '--as', TEAMMATE,
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('no author field');
    expect(seen).toEqual([]);
  });
});

// ── A14 update ──────────────────────────────────────────────────────────────

describe('interaction-profile update', () => {
  it('binds the draft PATCH under the optimistic guard', async () => {
    const r = await drive([
      'interaction-profile', 'update', PROFILE, '--expect-version', '3', '--data', DRAFT,
    ]);
    expect(r.code).toBe(0);
    expect(seen[0]?.method).toBe('PATCH');
    expect(seen[0]?.pathname).toBe(`/v2/interaction-profiles/${PROFILE}/draft`);
    expect(keys()).toEqual(['clientMutationId', 'draft', 'expectedVersion']);
    expect(body().expectedVersion).toBe(3);
  });

  it('requires --expect-version', async () => {
    const r = await drive(['interaction-profile', 'update', PROFILE, '--data', DRAFT]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--expect-version');
    expect(seen).toEqual([]);
  });

  it('refuses a non-integer guard', async () => {
    const r = await drive([
      'interaction-profile', 'update', PROFILE, '--expect-version', 'latest', '--data', DRAFT,
    ]);
    expect(r.code).toBe(2);
    expect(seen).toEqual([]);
  });

  it('requires the profile id', async () => {
    const r = await drive([
      'interaction-profile', 'update', '--expect-version', '3', '--data', DRAFT,
    ]);
    expect(r.code).toBe(2);
    expect(seen).toEqual([]);
  });
});

// ── A15 validate ────────────────────────────────────────────────────────────

describe('interaction-profile validate', () => {
  it('binds validate with only the guard and the mutation id', async () => {
    const r = await drive(['interaction-profile', 'validate', PROFILE, '--expect-version', '2']);
    expect(r.code).toBe(0);
    expect(seen[0]?.pathname).toBe(`/v2/interaction-profiles/${PROFILE}/validate`);
    expect(keys()).toEqual(['clientMutationId', 'expectedVersion']);
    expect(body().expectedVersion).toBe(2);
  });

  it('requires --expect-version', async () => {
    const r = await drive(['interaction-profile', 'validate', PROFILE]);
    expect(r.code).toBe(2);
    expect(seen).toEqual([]);
  });
});

// ── A16 preview — a READ that happens to POST ───────────────────────────────

describe('interaction-profile preview', () => {
  /**
   * Now driven through the REAL parser. It could not be, until the kernel slot
   * fixed the `--version` collision: this test previously had to hand the
   * command the OptionBag `parseInvocation` would have produced, because the
   * published flag never reached it. The bypass is gone — nothing here is
   * simulated any more.
   */
  it('sends only profileVersion: preview is a read and reserves no mutation', async () => {
    const r = await drive(['interaction-profile', 'preview', PROFILE, '--version', '2']);
    expect(r.code).toBe(0);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.pathname).toBe(`/v2/interaction-profiles/${PROFILE}/preview`);
    expect(keys()).toEqual(['profileVersion']);
    expect(body().profileVersion).toBe(2);
  });

  it('REGRESSION GUARD: `--version` after the command reaches the COMMAND, not the global', () => {
    // This collision shipped once: `version` was global in every position, so
    // the published A16 invocation printed the CLI version and exited 0 having
    // previewed nothing. The kernel slot fixed it positionally. Both published
    // spellings must now land in the command's option bag.
    for (const argv of [
      ['interaction-profile', 'preview', PROFILE, '--version', '2'],
      ['interaction-profile', 'preview', PROFILE, '--version=2'],
    ]) {
      const parsed = parseInvocation(argv);
      expect(parsed.globals.version, argv.join(' ')).toBe(false);
      expect(parsed.options.value('version'), argv.join(' ')).toBe('2');
    }
    // The global reading survives BEFORE any command token — the fix moved the
    // boundary, it did not remove the flag.
    expect(parseInvocation(['--version']).globals.version).toBe(true);
    // PROBE-RED: a non-global value flag DOES survive into the option bag, so
    // the two negatives above are facts about `--version` and not about the
    // parser dropping everything.
    const control = parseInvocation(['interaction-profile', 'validate', PROFILE, '--expect-version', '2']);
    expect(control.options.value('expect-version')).toBe('2');
  });

  it('requires --version, and no second spelling was ever invented for it', async () => {
    const r = await drive(['interaction-profile', 'preview', PROFILE]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--version');
    expect(seen).toEqual([]);
  });

  it('refuses --mutation-id: preview is a read', async () => {
    const r = await drive([
      'interaction-profile', 'preview', PROFILE, '--mutation-id', 'x',
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--mutation-id');
    expect(seen).toEqual([]);
  });
});

// ── A17 activate ────────────────────────────────────────────────────────────

describe('interaction-profile activate', () => {
  const ok = [
    'interaction-profile', 'activate', PROFILE,
    '--validated-version', '4', '--validation-hash', 'sha256:abc', '--yes',
  ];

  it('activates an EXACT validated artifact, never the latest draft', async () => {
    const r = await drive(ok);
    expect(r.code).toBe(0);
    expect(seen[0]?.pathname).toBe(`/v2/interaction-profiles/${PROFILE}/activate`);
    expect(keys()).toEqual(['clientMutationId', 'confirm', 'validatedHash', 'validatedVersion']);
    expect(body().validatedVersion).toBe(4);
    expect(body().validatedHash).toBe('sha256:abc');
    expect(body().confirm).toBe(true);
  });

  it('requires --yes', async () => {
    const r = await drive(ok.filter((a) => a !== '--yes'));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--yes');
    expect(seen).toEqual([]);
  });

  it('requires --validated-version and --validation-hash', async () => {
    const noVersion = await drive([
      'interaction-profile', 'activate', PROFILE, '--validation-hash', 'sha256:abc', '--yes',
    ]);
    expect(noVersion.code).toBe(2);
    expect(noVersion.stderr).toContain('--validated-version');

    const noHash = await drive([
      'interaction-profile', 'activate', PROFILE, '--validated-version', '4', '--yes',
    ]);
    expect(noHash.code).toBe(2);
    expect(noHash.stderr).toContain('--validation-hash');
    expect(seen).toEqual([]);
  });

  it('refuses an explicit --as with profile_principal_required (exit 4)', async () => {
    const r = await drive([...ok, '--as', TEAMMATE]);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('profile_principal_required');
    expect(seen).toEqual([]);
  });

  it('refuses an agent token with profile_principal_required (exit 4)', async () => {
    const r = await drive(ok, { TM8_AGENT_TOKEN: 'agent-token-value' });
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('profile_principal_required');
    expect(seen).toEqual([]);
    // Never echoes the credential it refused on.
    expect(r.stderr).not.toContain('agent-token-value');
  });
});

// ── A18 retire ──────────────────────────────────────────────────────────────

describe('interaction-profile retire', () => {
  it('sends the frozen guard the schema marks REQUIRED', async () => {
    const r = await drive(['interaction-profile', 'retire', PROFILE, '--expect-version', '5', '--yes']);
    expect(r.code).toBe(0);
    expect(seen[0]?.pathname).toBe(`/v2/interaction-profiles/${PROFILE}/retire`);
    expect(keys()).toEqual(['clientMutationId', 'confirm', 'expectedVersion']);
    expect(body().expectedVersion).toBe(5);
    expect(body().confirm).toBe(true);
  });

  it('REQUIRES --expect-version, because the frozen schema marks it required', async () => {
    const r = await drive(['interaction-profile', 'retire', PROFILE, '--yes']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--expect-version');
    // Refused locally: sending the body without it is a guaranteed 400, and a
    // guard the CLI made up for the caller would defeat the concurrency check.
    expect(seen).toEqual([]);
  });

  it('requires --yes', async () => {
    const r = await drive(['interaction-profile', 'retire', PROFILE, '--expect-version', '5']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--yes');
    expect(seen).toEqual([]);
  });

  it('refuses --as with profile_principal_required (exit 4)', async () => {
    const r = await drive(['interaction-profile', 'retire', PROFILE, '--expect-version', '5', '--yes', '--as', TEAMMATE]);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('profile_principal_required');
    expect(seen).toEqual([]);
  });

  it('renders the Server refusal faithfully when a default still points at it', async () => {
    reply = {
      status: 409,
      body: {
        error: {
          code: 'conflict',
          message: 'profile is still a default',
          requestId: 'req_c',
          retryable: false,
          details: { reason: 'profile_referenced_default' },
        },
      },
    };
    const r = await drive(['interaction-profile', 'retire', PROFILE, '--expect-version', '5', '--yes']);
    expect(r.code).toBe(6);
    expect(r.stderr).toContain('profile_referenced_default');
    expect(r.stdout).toBe('');
  });
});

// ── A19 teammate default ────────────────────────────────────────────────────

describe('teammate interaction-profile set-default', () => {
  it('binds the Teammate default PUT', async () => {
    const r = await drive([
      'teammate', 'interaction-profile', 'set-default', TEAMMATE, PROFILE, '--expect-version', '7', '--yes',
    ]);
    expect(r.code).toBe(0);
    expect(seen[0]?.method).toBe('PUT');
    expect(seen[0]?.pathname).toBe(`/v2/team-members/${TEAMMATE}/interaction-profile-default`);
    expect(keys()).toEqual(['clientMutationId', 'expectedVersion', 'profileId']);
    expect(body().expectedVersion).toBe(7);
    expect(body().profileId).toBe(PROFILE);
  });

  it('the literal `none` clears the default', async () => {
    const r = await drive([
      'teammate', 'interaction-profile', 'set-default', TEAMMATE, 'none', '--expect-version', '7', '--yes',
    ]);
    expect(r.code).toBe(0);
    expect(body().profileId).toBeNull();
  });

  it('requires both the teammate and the target', async () => {
    const noTarget = await drive([
      'teammate', 'interaction-profile', 'set-default', TEAMMATE, '--expect-version', '7', '--yes',
    ]);
    expect(noTarget.code).toBe(2);
    expect(noTarget.stderr).toContain('interaction-profile-id|none');

    const noTeammate = await drive([
      'teammate', 'interaction-profile', 'set-default', '--expect-version', '7', '--yes',
    ]);
    expect(noTeammate.code).toBe(2);
    expect(noTeammate.stderr).toContain('team-member-id');
    expect(seen).toEqual([]);
  });

  it('requires --yes', async () => {
    const r = await drive([
      'teammate', 'interaction-profile', 'set-default', TEAMMATE, PROFILE, '--expect-version', '7',
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--yes');
    expect(seen).toEqual([]);
  });

  it('REQUIRES --expect-version, because the frozen schema marks it required', async () => {
    const r = await drive([
      'teammate', 'interaction-profile', 'set-default', TEAMMATE, PROFILE, '--yes',
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--expect-version');
    expect(seen).toEqual([]);
  });

  it('refuses --as and an agent token with profile_principal_required', async () => {
    const asFlag = await drive([
      'teammate', 'interaction-profile', 'set-default', TEAMMATE, PROFILE,
      '--expect-version', '7', '--yes', '--as', TEAMMATE,
    ]);
    expect(asFlag.code).toBe(4);
    expect(asFlag.stderr).toContain('profile_principal_required');

    const token = await drive(
      ['teammate', 'interaction-profile', 'set-default', TEAMMATE, PROFILE, '--expect-version', '7', '--yes'],
      { TM8_AGENT_TOKEN: 'agent-token-value' },
    );
    expect(token.code).toBe(4);
    expect(token.stderr).toContain('profile_principal_required');
    expect(seen).toEqual([]);
  });
});

// ── A20 space default ───────────────────────────────────────────────────────

describe('space interaction-profile set-default', () => {
  it('binds the Space default PUT', async () => {
    const r = await drive([
      'space', 'interaction-profile', 'set-default', PROFILE, '--space', SPACE,
      '--expect-settings-revision', '3', '--yes',
    ]);
    expect(r.code).toBe(0);
    expect(seen[0]?.method).toBe('PUT');
    expect(seen[0]?.pathname).toBe(`/v2/spaces/${SPACE}/interaction-profile-default`);
    expect(keys()).toEqual(['clientMutationId', 'expectedSettingsRevision', 'profileId']);
    expect(body().expectedSettingsRevision).toBe(3);
    expect(body().profileId).toBe(PROFILE);
  });

  it('the literal `none` clears the Space default', async () => {
    const r = await drive([
      'space', 'interaction-profile', 'set-default', 'none', '--space', SPACE,
      '--expect-settings-revision', '3', '--yes',
    ]);
    expect(r.code).toBe(0);
    expect(body().profileId).toBeNull();
  });

  it('requires a Space in context', async () => {
    const r = await drive([
      'space', 'interaction-profile', 'set-default', PROFILE, '--expect-settings-revision', '3', '--yes',
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('no Space in context');
    expect(seen).toEqual([]);
  });

  it('requires --yes and the target', async () => {
    const noYes = await drive([
      'space', 'interaction-profile', 'set-default', PROFILE, '--space', SPACE,
      '--expect-settings-revision', '3',
    ]);
    expect(noYes.code).toBe(2);
    expect(noYes.stderr).toContain('--yes');

    const noTarget = await drive([
      'space', 'interaction-profile', 'set-default', '--space', SPACE,
      '--expect-settings-revision', '3', '--yes',
    ]);
    expect(noTarget.code).toBe(2);
    expect(noTarget.stderr).toContain('interaction-profile-id|none');
    expect(seen).toEqual([]);
  });

  it('refuses --as with profile_principal_required (exit 4)', async () => {
    const r = await drive([
      'space', 'interaction-profile', 'set-default', PROFILE, '--space', SPACE,
      '--expect-settings-revision', '3', '--yes', '--as', TEAMMATE,
    ]);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('profile_principal_required');
    expect(seen).toEqual([]);
  });

  it('REQUIRES --expect-settings-revision, kebab-cased from the frozen field', async () => {
    const r = await drive([
      'space', 'interaction-profile', 'set-default', PROFILE, '--space', SPACE, '--yes',
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--expect-settings-revision');
    expect(seen).toEqual([]);
  });

  it('renders an honest 501 faithfully and exits 8', async () => {
    reply = {
      status: 501,
      body: {
        error: {
          code: 'not_implemented',
          message: 'operation spaces.interactionProfile.setDefault is not implemented on this node',
          requestId: 'req_501',
          retryable: false,
        },
      },
    };
    const r = await drive([
      'space', 'interaction-profile', 'set-default', PROFILE, '--space', SPACE,
      '--expect-settings-revision', '3', '--yes',
    ]);
    expect(r.code).toBe(8);
    expect(r.stderr).toContain('is not implemented on this node');
    expect(r.stdout).toBe('');
  });
});
