/**
 * REAL-SERVER evidence for group 2 — `identity get` and `tm8 space …` against a
 * production Server child process on a freshly migrated scratch database.
 *
 * WHAT THIS FILE IS ALLOWED TO CLAIM, AND WHAT IT IS NOT.
 *
 *   G01 (identity.get + the nineteen spaces.* rows) is COMPOSED and
 *   independently W3-passed, so these rows can produce real behavioural
 *   evidence: a Space is really created, a task axis really round-trips, a real
 *   invite code is really minted by `create_invite`.
 *
 *   A01–A03 (`space menu get|update`, `space default-channel set`) were briefed
 *   as uncomposed rows that would answer an honest 501. THAT BRIEFING WENT
 *   STALE MID-SESSION: tranche-v3 composed G14, this file MEASURED it (the
 *   original 501 assertion failed), and the source was checked at
 *   `facade/index.ts:140` before the assertion was changed. Nothing below
 *   hard-codes either state — the assertions are on the INVARIANT that the CLI
 *   never disagrees with the node about availability, so they survive the next
 *   composition without an edit. Re-measure, never predict.
 *
 * WHY THE DOMAIN COMMANDS ARE DRIVEN IN-PROCESS AND THE BINARY IS DRIVEN TOO.
 * `src/commands/registry.ts` is coordinator-owned; this slot exports a
 * `CommandModule[]` and does not wire it. So the BUILT BINARY is exercised for
 * what it can honestly answer today — its own grammar, and the exit-8 that
 * distinguishes "documented, not built in this CLI build" from the Server's
 * 501 — while the command modules themselves are driven over real HTTP against
 * the same real Server, through the real client, the real catalog binding, the
 * real error taxonomy and the real output law. The test reads the BUILT
 * registry to decide which branch is truthful rather than accepting either.
 *
 * THREE-STATE AVAILABILITY IS NOT COLLAPSED. `server.observe()` answers
 * `unknown` for a registered operation whose handler never ran, because handler
 * lookup precedes schema validation and an empty body therefore cannot tell a
 * live handler from an unconditional 501 stub. Resolving `unknown` needs a
 * schema-valid body — domain work, which is what this file does.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { parseInvocation, splitCommandPath } from '../../src/args.js';
import { loadLocalConfig, resolveContext, sessionContextFromEnv } from '../../src/context.js';
import { errorLines, exitCodeFor } from '../../src/errors.js';
import { CliError, EXIT_USAGE } from '../../src/exit.js';
import { createOutput } from '../../src/output.js';
import { SPACE_COMMANDS } from '../../src/commands/space.js';
import { IDENTITY_COMMANDS } from '../../src/commands/identity.js';
import { assertBuilt, cli, REPO_ROOT, startRealServer, type RealServer } from './harness.js';

let server: RealServer;

beforeAll(async () => {
  await assertBuilt();
  server = await startRealServer('w4-g2-space');
  // Every count below is bound to THIS chain identity. A number without its
  // conditions is a rumour with a number attached.
  console.log(`[g2] bind-start ${server.bindStart.files}/${server.bindStart.digest} ${server.baseUrl}`);
}, 120_000);

afterAll(async () => {
  await server?.stop();
});

// ── the in-process driver: `run()`'s funnel, registry substituted ───────────

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

const MODULES = [...SPACE_COMMANDS, ...IDENTITY_COMMANDS];

async function tm8(argv: readonly string[]): Promise<Ran> {
  let stdout = '';
  let stderr = '';
  const streams = {
    stdout: (c: string | Uint8Array) => {
      stdout += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    },
    stderr: (c: string) => {
      stderr += c;
    },
  };
  let out = createOutput({ format: 'human', streams });
  const previous = process.env.TM8_BASE_URL;
  process.env.TM8_BASE_URL = server.baseUrl;
  try {
    const inv = parseInvocation(argv);
    out = createOutput({
      format: inv.globals.format,
      color: inv.globals.color,
      quiet: inv.globals.quiet,
      streams,
    });
    const known = new Set(MODULES.map((m) => m.path.join(' ')));
    const match = splitCommandPath(inv.positionals, (p) => known.has(p.join(' ')));
    if (!match) throw new CliError(`unknown command: ${inv.positionals.join(' ')}`, EXIT_USAGE);
    const mod = MODULES.find((m) => m.path.join(' ') === match.path.join(' '));
    if (!mod) throw new CliError('no module', EXIT_USAGE);
    const ctx = resolveContext({
      globals: inv.globals,
      session: sessionContextFromEnv(),
      config: loadLocalConfig(),
    });
    const code = await mod.run({
      path: match.path,
      args: match.args,
      options: inv.options,
      passthrough: inv.passthrough,
      ctx,
      out,
    });
    return { code, stdout, stderr };
  } catch (err) {
    out.error(errorLines(err));
    return { code: exitCodeFor(err), stdout, stderr };
  } finally {
    if (previous === undefined) delete process.env.TM8_BASE_URL;
    else process.env.TM8_BASE_URL = previous;
  }
}

/** Parsed stdout of a `--format json` run, so a failure names the command. */
async function json<T>(argv: readonly string[]): Promise<T> {
  const r = await tm8([...argv, '--format', 'json']);
  if (r.code !== 0) throw new Error(`\`${argv.join(' ')}\` exited ${r.code}: ${r.stderr}`);
  return JSON.parse(r.stdout) as T;
}

interface CreatedSpace {
  space: { id: string; name: string };
  memberId: string;
  defaultChannelId: string;
}

let created: CreatedSpace;

describe('the node itself', () => {
  it('reports an un-enveloped /health with the frozen route count', async () => {
    // `/health` is OUTSIDE the {data, requestId} envelope. `implemented` counts
    // REGISTERED handlers, which is NOT the same as behaviourally implemented —
    // `messages.post` is a registered 501 stub — so it is never quoted as
    // "implemented" here without the word "registered".
    const health = await server.health();
    expect(health.ok).toBe(true);
    expect(health.operations).toBe(124); // 120 -> 124 (2026-08-02): auth.* Identity v2 Stage 1 added four HTTP routes.
    console.log(`[g2] /health operations=${health.operations} registered=${health.implemented}`);
  });
});

describe('the BUILT binary — what it can honestly answer today', () => {
  it('renders this slot\'s syntax from the grammar projection, with no network', async () => {
    const r = await cli(['help', 'space', 'invite', 'create', '--format', 'json'], server);
    expect(r.code, r.stderr).toBe(0);
    const dto = JSON.parse(r.stdout) as { command: string; syntax: string };
    expect(dto.command).toBe('space invite create');
    expect(dto.syntax).toContain('tm8 space invite create');
  });

  it('names the dimension of every dimensioned option it renders', async () => {
    const r = await cli(['help', 'space', 'list', '--format', 'json'], server);
    const dto = JSON.parse(r.stdout) as { syntax: string };
    expect(dto.syntax).toContain('--limit <count>');
    expect(dto.syntax).not.toMatch(/--limit <n>/);
  });

  it('tells "documented, not built in this CLI build" apart from the Server\'s 501', async () => {
    // Two different exit-8s with two different sentences. Collapsing them is how
    // an operator retries a build problem against the Server, or the reverse.
    const { isRegisteredPath } = (await import(
      join(REPO_ROOT, 'packages/cli/dist/commands/registry.js')
    )) as { isRegisteredPath(path: readonly string[]): boolean };
    const wired = isRegisteredPath(['space', 'list']);
    console.log(`[g2] built registry wired for \`space list\`: ${wired}`);

    const r = await cli(['space', 'list', '--format', 'json'], server);
    if (wired) {
      expect(r.code, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toBeInstanceOf(Array);
    } else {
      expect(r.code).toBe(8);
      expect(r.stderr).toContain('is not implemented in this CLI build');
      expect(r.stderr).not.toContain('is not implemented on this node');
    }
  }, 60_000);
});

/**
 * The strongest evidence class available to this slot: `packages/cli/dist/index.js`
 * spawned as a child process, talking HTTP to a real Server child process, the
 * way an agent actually invokes it — no in-process shortcut anywhere in the
 * path. It runs only once the coordinator has wired this slot's modules into
 * `registry.ts`, and SKIPS ITSELF LOUDLY rather than silently passing when they
 * are not, because a skipped test reported as a pass is how coverage gets
 * claimed for a path nobody executed.
 */
describe('the BUILT binary, end to end, on this slot\'s own rows', () => {
  it('creates, reads and invites through dist/index.js against the real Server', async () => {
    const { isRegisteredPath } = (await import(
      join(REPO_ROOT, 'packages/cli/dist/commands/registry.js')
    )) as { isRegisteredPath(path: readonly string[]): boolean };
    if (!isRegisteredPath(['space', 'create'])) {
      console.log('[g2] SKIPPED — dist registry has no `space create`; built-binary evidence NOT claimed');
      return;
    }

    const made = await cli(['space', 'create', 'W4 G2 Built-Binary Space', '--format', 'json'], server);
    expect(made.code, made.stderr).toBe(0);
    const dto = JSON.parse(made.stdout) as CreatedSpace;
    expect(dto.space.name).toBe('W4 G2 Built-Binary Space');

    const read = await cli(['space', 'get', dto.space.id, '--format', 'json'], server);
    expect(read.code, read.stderr).toBe(0);
    expect((JSON.parse(read.stdout) as { id: string }).id).toBe(dto.space.id);

    // Human output keeps the id a follow-up needs, and stdout stays data-only.
    const human = await cli(['space', 'get', dto.space.id], server);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toContain(dto.space.id);

    // A real invite code, minted by the real RPC, through the real binary.
    const invited = await cli(['space', 'invite', 'create', dto.space.id, '--format', 'json'], server);
    expect(invited.code, invited.stderr).toBe(0);
    expect((JSON.parse(invited.stdout) as { code: string }).code.length).toBeGreaterThan(0);
    expect(invited.stderr).toMatch(/bearer/i);
    console.log(`[g2] built-binary invite create -> stderr: ${invited.stderr.trim()}`);

    // §7.5 through the real binary: destructive without consent, exit 2.
    const unconfirmed = await cli(['space', 'invite', 'revoke', 'whatever', '--space', dto.space.id], server);
    expect(unconfirmed.code).toBe(2);
    expect(unconfirmed.stdout).toBe('');
    // Six child-process spawns of the built binary; vitest's 5s default is a
    // clock, not a verdict, and letting it decide would report a boot budget as
    // a behavioural failure.
  }, 60_000);
});

describe('G01 — composed, and therefore really exercised', () => {
  it('identity.get answers with the loopback auto-owner this process is', async () => {
    const me = await json<{ identityId: string; username: string; isOwner: boolean }>([
      'identity', 'get',
    ]);
    // Measured, not assumed: this node issues PREFIXED identity ids
    // (`id_<uuid>`), not bare UUIDs. An earlier draft of this assertion asserted
    // a bare UUID and failed — the shape is the Server's to define.
    expect(me.identityId.length).toBeGreaterThan(0);
    expect(typeof me.username).toBe('string');
    console.log(`[g2] identity.get -> ${me.identityId} ${me.username} isOwner=${me.isOwner}`);
  });

  it('resolves the harness\'s `unknown` for spaces.create by sending a VALID body', async () => {
    // The harness probe can only reach 'unknown' here: an empty body is rejected
    // by validation before the handler runs, so a live handler and an
    // unconditional 501 stub are indistinguishable from outside. A schema-valid
    // body is the only thing that tells them apart, and that is domain work.
    expect(await server.observe('spaces.create')).toBe('unknown');

    created = await json<CreatedSpace>(['space', 'create', 'W4 G2 Evidence Space']);
    expect(created.space.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.space.name).toBe('W4 G2 Evidence Space');
    expect(created.memberId).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.defaultChannelId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('spaces.list then contains the Space that was really created', async () => {
    const spaces = await json<Array<{ id: string; name: string }>>(['space', 'list']);
    expect(spaces.map((s) => s.id)).toContain(created.space.id);
  });

  it('spaces.get, navigation, home and settings all read the same real Space', async () => {
    const space = await json<{ id: string }>(['space', 'get', created.space.id]);
    expect(space.id).toBe(created.space.id);

    const nav = await json<{ spaceId: string; channels: unknown[] }>([
      'space', 'navigation', 'get', created.space.id,
    ]);
    expect(nav.spaceId).toBe(created.space.id);
    expect(nav.channels.length).toBeGreaterThan(0);

    const home = await tm8(['space', 'home', 'get', created.space.id, '--format', 'json']);
    expect(home.code, home.stderr).toBe(0);

    const settings = await json<{ settingsRevision: number; members: unknown[] }>([
      'space', 'settings', 'get', created.space.id,
    ]);
    expect(settings.members.length).toBeGreaterThan(0);
    expect(typeof settings.settingsRevision).toBe('number');
  });

  it('spaces.update really changes the Space, and refuses an empty patch locally', async () => {
    const renamed = await json<{ name: string }>([
      'space', 'update', created.space.id, '--name', 'W4 G2 Renamed',
    ]);
    expect(renamed.name).toBe('W4 G2 Renamed');

    const empty = await tm8(['space', 'update', created.space.id]);
    expect(empty.code).toBe(2);
  });

  it('spaces.members.list finds the owner member row spaces.create minted', async () => {
    const members = await json<Array<{ actor: { id: string }; role: string }>>([
      'space', 'member', 'list', created.space.id,
    ]);
    expect(members.map((m) => m.actor.id)).toContain(created.memberId);
    expect(members.find((m) => m.actor.id === created.memberId)?.role).toBe('owner');
  });

  it('task axes really round-trip: create, list, update, delete', async () => {
    const axis = await json<{ id: string; name: string; axisValues: string[] }>([
      'space', 'task-axis', 'create', 'Risk',
      '--space', created.space.id,
      '--value', 'low', '--value', 'high',
      '--kind', 'manual',
      '--position', '7',
    ]);
    expect(axis.axisValues).toEqual(['low', 'high']);

    const listed = await json<Array<{ id: string }>>(['space', 'task-axis', 'list', created.space.id]);
    expect(listed.map((a) => a.id)).toContain(axis.id);

    const updated = await json<{ position: number; axisValues: string[] }>([
      'space', 'task-axis', 'update', axis.id,
      '--space', created.space.id,
      '--name', 'Risk',
      '--value', 'low', '--value', 'medium', '--value', 'high',
      '--kind', 'manual',
      '--position', '9',
    ]);
    expect(updated.position).toBe(9);
    expect(updated.axisValues).toEqual(['low', 'medium', 'high']);

    // §7.5: destructive, so consent is required — and refused locally, before
    // the network, which is why the axis is still there when we then delete it.
    const unconfirmed = await tm8(['space', 'task-axis', 'delete', axis.id, '--space', created.space.id]);
    expect(unconfirmed.code).toBe(2);

    const gone = await tm8([
      'space', 'task-axis', 'delete', axis.id, '--space', created.space.id, '--yes', '--format', 'json',
    ]);
    expect(gone.code, gone.stderr).toBe(0);
    const after = await json<Array<{ id: string }>>(['space', 'task-axis', 'list', created.space.id]);
    expect(after.map((a) => a.id)).not.toContain(axis.id);
  });

  it('leaderboard and awards answer real contract Pages', async () => {
    const board = await json<{ items: unknown[]; nextCursor: string | null }>([
      'space', 'leaderboard', 'get', created.space.id, '--limit', '5',
    ]);
    expect(Array.isArray(board.items)).toBe(true);
    expect(board).toHaveProperty('nextCursor');

    const awards = await json<{ items: unknown[]; nextCursor: string | null }>([
      'space', 'award', 'list', created.space.id, '--limit', '5',
    ]);
    expect(Array.isArray(awards.items)).toBe(true);
  });
});

describe('INVITE CODES — a real code, from the real create_invite RPC', () => {
  it('mints one, renders it faithfully, and retains nothing', async () => {
    const invite = await json<{ id: string; code: string; maxUses: number }>([
      'space', 'invite', 'create', created.space.id, '--max-uses', '3',
    ]);
    // FAITHFUL RENDER: the Server disclosed a live bearer credential and the CLI
    // shows it. Masking it here would hide a server-side disclosure from the
    // gate whose job is to see it — `create_invite` has a MEASURED live defect
    // where a ledger replay can return another principal's stored result, and
    // that stored result carries this column.
    expect(invite.code.length).toBeGreaterThan(0);
    expect(invite.maxUses).toBe(3);

    const human = await tm8(['space', 'invite', 'create', created.space.id]);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stderr).toMatch(/bearer/i);
    // ZERO RETENTION: the note says what the material is; it does not tell the
    // reader what to do, because in a PTY this line lands in an agent's context.
    expect(human.stderr).not.toMatch(/\b(you should|you must|please|remember to)\b/i);

    const listed = await json<Array<{ id: string; code: string }>>([
      'space', 'invite', 'list', created.space.id,
    ]);
    expect(listed.map((i) => i.id)).toContain(invite.id);

    const revoked = await json<{ id: string; revoked: boolean }>([
      'space', 'invite', 'revoke', invite.id, '--space', created.space.id, '--yes',
    ]);
    expect(revoked.id).toBe(invite.id);
    expect(revoked.revoked).toBe(true);
  });

  it('invite redeem reaches a real handler — availability, not a business claim', async () => {
    const invite = await json<{ code: string }>(['space', 'invite', 'create', created.space.id]);
    const r = await tm8(['space', 'invite', 'redeem', invite.code]);
    // The identity redeeming is already this Space's owner, so the BUSINESS
    // outcome is the Server's to decide and is deliberately not asserted. What
    // IS asserted is the availability claim this slot actually makes: a handler
    // ran. An honest 501 would be exit 8 with the node refusal text.
    expect(r.code).not.toBe(8);
    expect(r.stderr).not.toContain('is not implemented on this node');
    console.log(`[g2] space invite redeem -> exit ${r.code} ${r.stderr.trim().slice(0, 120)}`);
  });
});

/**
 * A01–A03. This slot's packet said these three were G14 residual and would
 * answer an honest 501; the first run of this file MEASURED otherwise, and the
 * coordinator independently confirmed that tranche-v3 composed G14. So none of
 * the assertions below hard-code either state.
 *
 * They assert the INVARIANT instead: whatever this node says, the CLI must
 * agree with it. A CLI that reports "not implemented on this node" for an
 * operation that answers, or that hides a 501 behind some other code, is wrong
 * in the same way in both directions — and that property survives the next
 * composition without anyone editing this file.
 */
describe('A01–A03 — the CLI never disagrees with the node about availability', () => {
  const RESIDUAL = [
    { op: 'spaces.menu.get', argv: ['space', 'menu', 'get'] },
    {
      op: 'spaces.menu.update',
      argv: ['space', 'menu', 'update', '--expect-revision', '1', '--data', '{"schemaVersion":1,"groups":[]}'],
    },
    { op: 'spaces.defaultChannel.set', argv: ['space', 'default-channel', 'set', 'none'] },
  ] as const;

  it('reports exit 8 with the literal refusal exactly when the node answers 501', async () => {
    let checked = 0;
    for (const row of RESIDUAL) {
      const observed = await server.observe(row.op);
      const r = await tm8([...row.argv, '--space', created.space.id]);
      console.log(`[g2] ${row.op}: observe=${observed} cli=exit ${r.code} ${r.stderr.trim().slice(0, 140)}`);
      if (observed === 'unavailable') {
        expect(r.code, `${row.op}: ${r.stderr}`).toBe(8);
        expect(r.stderr, row.op).toContain(`operation ${row.op} is not implemented on this node`);
      } else {
        // Composed. The refusal text is per-NODE availability and must NOT
        // appear for an operation whose handler ran, whatever it answered.
        expect(r.code, row.op).not.toBe(8);
        expect(r.stderr, row.op).not.toContain('is not implemented on this node');
      }
      expect(r.stdout === '' || r.code === 0, row.op).toBe(true);
      checked++;
    }
    // Vacuity guard: a sweep that iterates zero rows agrees with everything.
    expect(checked).toBe(3);
  });

  it('the three-state probe discriminates — it is not stuck on one answer', async () => {
    // Positive control in BOTH directions. A probe that can only ever say one
    // thing has measured nothing, and `unknown` is the state most easily
    // mistaken for a verdict: it means "registered, handler never ran".
    expect(await server.observe('spaces.list')).toBe('available');
    expect(await server.observe('spaces.create')).toBe('unknown');
    expect(await server.observe('search.query')).toBe('unavailable');
  });

  it('A01+A02 really round-trip the menu now that G14 is composed', async () => {
    const observed = await server.observe('spaces.menu.get');
    if (observed === 'unavailable') {
      console.log('[g2] A01 still 501 on this node — menu round-trip skipped, not failed');
      return;
    }
    const menu = await json<{ revision: number; schemaVersion: number; groups: unknown[] }>([
      'space', 'menu', 'get', created.space.id,
    ]);
    expect(menu.schemaVersion).toBe(1);
    expect(typeof menu.revision).toBe('number');

    // `MenuConfigPayloadSchema` is strict and has NO `revision` key — the
    // revision travels in `--expect-revision`, not in the payload. Sending the
    // read DTO back unchanged would therefore be rejected, which is exactly the
    // read/write asymmetry `--data` has to respect.
    const payload = { schemaVersion: menu.schemaVersion, groups: menu.groups };
    const updated = await json<{ revision: number }>([
      'space', 'menu', 'update', created.space.id,
      '--expect-revision', String(menu.revision),
      '--data', JSON.stringify(payload),
    ]);
    expect(updated.revision).toBeGreaterThan(menu.revision);
    console.log(`[g2] A02 menu revision ${menu.revision} -> ${updated.revision}`);

    // ACCEPTANCE proved the field name is right and `.strict()` took it.
    // REFUSAL is the one that proves the guard is ENFORCED rather than merely
    // parsed: a handler could accept `expectedRevision` and never compare it,
    // and that looks identical to a working guard on every happy path.
    const stale = await tm8([
      'space', 'menu', 'update', created.space.id,
      '--expect-revision', String(menu.revision),
      '--data', JSON.stringify(payload),
    ]);
    console.log(`[g2] A02 stale guard replay @rev ${menu.revision} -> exit ${stale.code}: ${stale.stderr.trim().slice(0, 160)}`);
    expect(stale.code).toBe(6);

    // OMISSION: required-ness is real, not decorative.
    const omitted = await tm8([
      'space', 'menu', 'update', created.space.id, '--data', JSON.stringify(payload),
    ]);
    expect(omitted.code).toBe(2);
    console.log(`[g2] A02 guard omitted -> exit ${omitted.code}: ${omitted.stderr.trim().slice(0, 120)}`);
  });

  it('A03 SUCCEEDS once it carries the guard its frozen schema requires', async () => {
    const observed = await server.observe('spaces.defaultChannel.set');
    if (observed === 'unavailable') {
      console.log('[g2] A03 still 501 on this node — guard round-trip unobservable, not disproved');
      return;
    }
    // HISTORY, because it is the evidence for the ruling: before the guard flag
    // existed this row answered `invalid_input: Required` for the only body the
    // grammar could build, i.e. the operation was DEAD. `--expect-revision`
    // is a RESTORATION of a capability the frozen schema always required, not an
    // invented flag — the field name comes from runtime introspection of
    // `SetDefaultChannelInputSchema`, kebab-cased with nothing dropped.
    const settings = await json<{ settingsRevision: number; defaultChannelId: string | null }>([
      'space', 'settings', 'get', created.space.id,
    ]);

    // A REAL CHANGE, not a no-op. `spaces.create` already made this channel the
    // default, so re-setting it to itself takes the
    // `default_channel_id is distinct from p_channel_id` branch at
    // 029_w2_menu_default_channel.sql:594 and does NOT bump the revision.
    // An earlier version of this test set it to itself and then read the
    // unchanged revision as a fictional guard — the server was right and the
    // assertion was wrong. Clearing to `none` is a genuine transition.
    expect(settings.defaultChannelId).toBe(created.defaultChannelId);
    const before = settings.settingsRevision;

    const ok = await tm8([
      'space', 'default-channel', 'set', 'none',
      '--space', created.space.id,
      '--expect-revision', String(before),
      '--format', 'json',
    ]);
    console.log(`[g2] A03 set none @rev ${before} -> cli exit ${ok.code} ${ok.stderr.trim().slice(0, 140)}`);
    expect(ok.code, ok.stderr).toBe(0);
    expect(ok.stderr).not.toContain('is not implemented on this node');

    // MECHANISM, not symptom: the write really landed and the revision really
    // moved. Asserting only "exit 0" would pass for a handler that ignored the
    // body entirely.
    const after = await json<{ settingsRevision: number; defaultChannelId: string | null }>([
      'space', 'settings', 'get', created.space.id,
    ]);
    expect(after.defaultChannelId).toBeNull();
    expect(after.settingsRevision).toBe(before + 1);
    console.log(`[g2] A03 revision ${before} -> ${after.settingsRevision}, defaultChannelId now null`);

    // THE GUARD IS REAL, not decoration: replaying the NOW-genuinely-stale
    // revision must refuse. A guard the Server ignores would be the
    // fictional-guard defect wearing a correct flag name.
    const stale = await tm8([
      'space', 'default-channel', 'set', created.defaultChannelId,
      '--space', created.space.id,
      '--expect-revision', String(before),
    ]);
    console.log(`[g2] A03 stale guard replay @rev ${before} -> exit ${stale.code}: ${stale.stderr.trim().slice(0, 160)}`);
    expect(stale.code, 'a stale settings revision must be refused').not.toBe(0);
  });
});

/**
 * PAGING SWEEP over the two rows this slot owns that answer a `Page<T>`.
 *
 * The class: a cursor that round-trips a Postgres `timestamptz` (MICROseconds)
 * through a JS `Date` (MILLIseconds) is truncated, and the two directions are
 * not equally visible:
 *   truncated DOWN -> cursor too SMALL -> re-admits the boundary row -> duplicates, loops. LOUD.
 *   rounded UP     -> cursor too LARGE -> SKIPS rows -> SILENT DATA LOSS. No error, no loop.
 * A suite that asserts only "terminates" and "no overlap" is blind to the worse
 * half, so the assertion below is over MICROSECOND FIDELITY of the cursor read
 * back off the wire — the mechanism — rather than over a downstream symptom.
 */
describe('paging rows owned by this slot', () => {
  it('leaderboard is IMMUNE by construction — reported as a disproof, not a pass', async () => {
    // `spaces.leaderboard` encodes `[Number(score), actorId]`. The first
    // component is an integer, never a timestamp, so no Date round-trip exists
    // to truncate. Stated as a disproof because "this row is fine" is a finding
    // only when the reason is given.
    const board = await json<{ items: unknown[]; nextCursor: string | null }>([
      'space', 'leaderboard', 'get', created.space.id, '--limit', '1',
    ]);
    expect(board).toHaveProperty('nextCursor');
    if (board.nextCursor) {
      const decoded = JSON.parse(Buffer.from(board.nextCursor, 'base64url').toString()) as { k: unknown[] };
      expect(typeof decoded.k[0]).toBe('number');
      console.log(`[g2] leaderboard cursor key0 type=${typeof decoded.k[0]} value=${String(decoded.k[0])}`);
    } else {
      console.log('[g2] leaderboard: no second page in this fixture; immunity argued from the encoding, not measured');
    }
  });

  it('awards cursor: microsecond fidelity, or an explicit NOT-MEASURED', async () => {
    const awards = await json<{ items: unknown[]; nextCursor: string | null }>([
      'space', 'award', 'list', created.space.id, '--limit', '1',
    ]);
    if (!awards.nextCursor) {
      // NOT a pass. `reason='award'` point_events are minted only by the
      // task-completion RPC (007_rpc_catalog.sql:1859), which is not reachable
      // from this slot's command surface, so this fixture has none. Saying so
      // is the point: an assertion over an absent cursor would compare
      // undefined to undefined and pass while measuring nothing.
      console.log(
        '[g2] awards: NO nextCursor in this fixture (0 awards) — truncation NOT MEASURED here, ' +
          'only traced in source. See the report; this is not evidence of correctness.',
      );
      expect(awards.items).toEqual([]);
      return;
    }
    const decoded = JSON.parse(Buffer.from(awards.nextCursor, 'base64url').toString()) as { k: unknown[] };
    const stamp = String(decoded.k[0]);
    console.log(`[g2] awards cursor key0=${stamp}`);
    // Six fractional digits, matching the stored timestamptz verbatim. A
    // three-digit tail is the JS `Date` round-trip, caught at the point of
    // truncation rather than as a paging symptom later.
    expect(stamp, 'awards cursor lost sub-millisecond precision').toMatch(/\.\d{6}/);
  });

  it('the CLI adds NO client-side paging compensation, in either direction', async () => {
    // Whatever the Server encodes, the CLI relays byte-for-byte. Compensating
    // here would hide a server defect inside the client from the gate that has
    // to see it — and would silently corrupt a correct cursor once fixed.
    const first = await json<{ nextCursor: string | null }>([
      'space', 'leaderboard', 'get', created.space.id, '--limit', '1',
    ]);
    if (!first.nextCursor) {
      console.log('[g2] no cursor to relay in this fixture; pass-through asserted in the unit suite instead');
      return;
    }
    const echoed = await tm8([
      'space', 'leaderboard', 'get', created.space.id, '--cursor', first.nextCursor, '--format', 'json',
    ]);
    expect(echoed.code, echoed.stderr).toBe(0);
  });
});

describe('the bind this run is anchored to', () => {
  it('is still coherent, so the counts above mean something', async () => {
    // If this throws, another wave landed migrations mid-run: the scratch
    // database was built from one tree and the assertions ran against another.
    // DISCARD the run and re-run — it is not a defect and not a result.
    await server.assertBindCoherent();
    console.log(`[g2] bind-end coherent at ${server.bindStart.files}/${server.bindStart.digest}`);
  });
});
