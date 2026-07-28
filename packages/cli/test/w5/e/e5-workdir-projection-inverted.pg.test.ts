/**
 * W5 DUO E — E-5: THE `--workdir` PROJECTION NOTE IS INVERTED.
 *
 * ── THE CLAIM ─────────────────────────────────────────────────────────────
 *
 * `discovery/operations.ts:891` — the note an agent reads through `tm8 help
 * session spawn` — says:
 *
 *     "`--workdir worktree` is discoverable reserved syntax and answers
 *      not_implemented until its gate closes"
 *
 * The server does the opposite. `facade/execution-handlers.ts:555-557` throws
 * `notImplemented` for **scratch**, and `:565-567` passes **project** and
 * **worktree** through as `supportedWorkdir`. `worktree` is IMPLEMENTED;
 * `scratch` is the reserved one.
 *
 * ⚠ THE HARM IS NOT A WRONG LABEL, IT IS AN AGENT STEERED INTO THE FAILING
 * MODE. A planner reading the projection avoids `worktree` — believing it
 * unavailable — and reaches for `scratch`, which is the one that 501s. The note
 * does not merely fail to help; it inverts the choice.
 *
 * Same class as the `commands.undo` note that said redemption restores when it
 * redacts. That one was found and fixed (`operations.ts:615`). THIS ONE IS LIVE.
 *
 * ── AUTHORITY, STATED BECAUSE ONE SOURCE HERE HAS NONE ────────────────────
 *
 * `TM8-CLI-GRAMMAR-REDESIGN.md:705` ("without a launch Project, `scratch` is
 * required") CORROBORATES the trap — an agent following it lands on the mode
 * that 501s. It is cited for colour ONLY. Per the class ruling that closed E-4,
 * **that document is a DESIGN RECORD AND NOT AN AUTHORITY over the shipped
 * surface**, and no claim in this file rests on it. The finding stands entirely
 * on two EXECUTABLE authorities disagreeing: the shipped projection and the
 * shipped handler.
 *
 * ── WHY A NONEXISTENT TEAMMATE IS SUFFICIENT, AND THIS IS THE CHEAP PART ──
 *
 * The workdir check is the FIRST statement in the handler — before
 * `resolveOwner()`, before `claimsFor`, before `spawnService.spawn`. So a
 * schema-valid body naming a teammate that does not exist STILL REACHES IT.
 * That is what makes this drivable without minting a real Teammate fixture, and
 * it is a property of the handler's ordering rather than an assumption: if the
 * ordering ever changes, the positive control below fails and says so.
 *
 * ── WHAT THIS FILE DOES NOT CLAIM ─────────────────────────────────────────
 *
 * It does NOT claim `--workdir worktree` SUCCEEDS. It claims only that worktree
 * is NOT refused as unimplemented while scratch IS. A spawn naming a
 * nonexistent teammate must fail; the question is only WHICH failure, and
 * `not_implemented` is the one under test. Asserting success would need a real
 * Teammate and would be measuring the spawn path, which is not this finding.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { cli, assertBuilt, startRealServer, type RealServer } from '../../integration/harness.js';
import { DISCOVERY } from '../../../src/discovery/operations.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });

/** A syntactically valid id that names nothing. See the header. */
const ABSENT_TEAMMATE = '019fa297-64e3-7000-8000-0000000000aa';

let server: RealServer;
let spaceId = '';
const measured: Record<string, unknown> = {};

beforeAll(async () => {
  await assertBuilt();
  server = await startRealServer('w5-e-workdir');

  const mk = await cli(['space', 'create', 'W5E workdir', '--format', 'json'], server);
  expect(mk.code, mk.stderr).toBe(0);
  const created = JSON.parse(mk.stdout) as { id?: string; space?: { id?: string } };
  spaceId = created.space?.id ?? created.id ?? '';
  expect(spaceId, `no space id in ${mk.stdout}`).toBeTruthy();
  measured['fixture'] = { spaceId, baseUrl: server.baseUrl };
});

afterAll(async () => {
  if (server !== undefined) {
    await server.assertBindCoherent().catch((e: unknown) => {
      measured['bindCoherent'] = `THREW — every number here is VOID: ${String(e)}`;
    });
    measured['bindStart'] = server.bindStart;
    await server.stop();
  }
  console.log('[w5-e][workdir-projection]', JSON.stringify(measured, null, 2));
});

async function spawnWith(workdir?: string): Promise<{ code: number; stderr: string }> {
  const argv = [
    'session', 'spawn',
    '--space', spaceId,
    '--teammate', ABSENT_TEAMMATE,
    '--mutation-id', randomUUID(),
    ...(workdir ? ['--workdir', workdir] : []),
  ];
  const r = await cli(argv, server);
  return { code: r.code, stderr: r.stderr.trim() };
}

/** The signal under test, read off the wire rather than inferred from an exit code. */
function isNotImplemented(stderr: string): boolean {
  return /not_implemented|not implemented/i.test(stderr);
}

describe('CONTROL — the request reaches the handler at all', () => {
  /**
   * Without this, every result below is explained equally well by "the body was
   * rejected before any handler ran". A spawn naming an absent teammate must
   * FAIL — that is expected and is the point — but it must fail from the
   * HANDLER, not from the router or the schema.
   */
  it('a spawn with NO --workdir fails, and NOT as not_implemented', async () => {
    const r = await spawnWith();
    measured['control.noWorkdir'] = r;

    expect(r.code, 'a spawn naming an absent teammate must not succeed').not.toBe(0);
    expect(
      isNotImplemented(r.stderr),
      'the baseline spawn path itself answers not_implemented — the discriminator below is meaningless',
    ).toBe(false);
  });
});

describe('E-5 — the projection and the handler disagree about which mode is reserved', () => {
  /**
   * The handler's own reserved mode. `execution-handlers.ts:555-557`.
   * This is the mode the projection says NOTHING about.
   */
  it('--workdir scratch IS refused as not_implemented', async () => {
    const r = await spawnWith('scratch');
    measured['scratch'] = r;
    expect(isNotImplemented(r.stderr), `expected not_implemented, got: ${r.stderr}`).toBe(true);
  });

  /**
   * ⚠ THE ASSERTION THE FINDING RESTS ON. The projection says this mode answers
   * not_implemented. `execution-handlers.ts:565-567` passes it through as
   * supported. If this test goes RED, the projection is right and my reading of
   * the handler is wrong — which is exactly the outcome I want to be told about.
   */
  it('--workdir worktree is NOT refused as not_implemented, contradicting the note', async () => {
    const r = await spawnWith('worktree');
    measured['worktree'] = r;
    expect(
      isNotImplemented(r.stderr),
      'the projection says worktree answers not_implemented; the handler supports it',
    ).toBe(false);
  });

  /**
   * Pins the CONTRADICTION structurally rather than pinning the prose.
   *
   * It does NOT assert particular wording — §8 of the W4 handoff is explicit
   * that a test matching prose "goes red when an owner legitimately rewords
   * their own file", which punishes the correct action. It asserts the
   * DISAGREEMENT: that the note names a mode the wire does not refuse.
   *
   * So the honest repair — renaming the mode in the note — turns this green,
   * and a reword that keeps the inversion keeps it red.
   */
  it('the shipped note names the WRONG mode, checked against the wire', async () => {
    // ⚠ `DISCOVERY` IS A READONLY ARRAY, NOT A KEYED MAP (`operations.ts:1312`).
    // The raw table in that file IS keyed by operation name, and reading the
    // table led me to index the EXPORT the same way. It returned `undefined`,
    // which this test reported as "the note is gone — this finding may be
    // fixed" — a false ALL-CLEAR from a shape assumption, in the reassuring
    // direction. The in-tree idiom is `.find(...)`, per
    // `discovery-operations.test.ts:72`.
    const row = DISCOVERY.find((d) => d.operation === 'execution.spawn');
    const notes = row?.notes ?? [];
    const workdirNote = notes.find((n) => /workdir/.test(n) && /not_implemented/.test(n));
    measured['projection.note'] = workdirNote;
    expect(workdirNote, 'no workdir/not_implemented note found — this finding may be fixed').toBeDefined();

    const namesWorktree = /worktree/.test(workdirNote!);
    const namesScratch = /scratch/.test(workdirNote!);
    measured['projection.namesWorktree'] = namesWorktree;
    measured['projection.namesScratch'] = namesScratch;

    // The wire's verdict, re-measured in this test rather than inherited.
    const worktreeRefused = isNotImplemented((await spawnWith('worktree')).stderr);
    const scratchRefused = isNotImplemented((await spawnWith('scratch')).stderr);
    measured['wire.worktreeRefused'] = worktreeRefused;
    measured['wire.scratchRefused'] = scratchRefused;

    expect(
      namesWorktree && !worktreeRefused,
      'the note names worktree as not_implemented while the wire accepts it',
    ).toBe(false);
    expect(
      scratchRefused && !namesScratch,
      'the wire refuses scratch and the note never mentions it',
    ).toBe(false);
  });
});
