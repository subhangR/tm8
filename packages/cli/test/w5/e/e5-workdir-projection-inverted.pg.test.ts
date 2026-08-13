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
 * `CLI-GRAMMAR-REDESIGN.md:705` ("without a launch Project, `scratch` is
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
 * ── ⚠ SCOPE OF THIS WITNESS vs SCOPE OF THE DEFECT — READ BEFORE GATING ───
 *
 * **THIS WITNESS PINS THE AGENT-FACING PROJECTION ONLY. IT WILL GO GREEN ON A
 * FIX TO `discovery/operations.ts:891` ALONE, WHILE A SECOND FALSE STATEMENT
 * REMAINS IN THE TREE.** Flagged here, before the fix lands, so its green is
 * never read as covering more than it does.
 *
 * MY OWN EXHAUSTIVE SWEEP of `worktree` across `packages/cli/src`, classified
 * rather than counted — the count is 7 and the number that are FALSE is 2:
 *
 *   FALSE, agent-facing, PINNED BY THIS FILE:
 *     discovery/operations.ts:891   "answers not_implemented until its gate closes"
 *
 *   FALSE, maintainer-facing, NOT PINNED HERE:
 *     commands/session.ts:23-25     "`--workdir worktree` is therefore SENT, and
 *                                    the Server's honest `not_implemented` is
 *                                    what the caller sees" — the caller sees no
 *                                    such thing; the wire accepts worktree.
 *
 *   TRUE — and I checked rather than assuming, because it was reported to me as
 *   a third copy of the same lie and it is NOT:
 *     commands/session.ts:131-133   "`worktree` additionally admits a `baseRef`,
 *                                    which the frozen projection gives no flag
 *                                    for". **VERIFIED TRUE**:
 *                                    `contract/src/schemas.ts:1201` gives
 *                                    worktree `baseRef: z.string().nullable()
 *                                    .optional()`, and `--base-ref` occurs
 *                                    NOWHERE in `packages/cli/src`. It is an
 *                                    accurate statement of a real and separate
 *                                    expressiveness gap, on a DIFFERENT subject
 *                                    (baseRef, not implementation status).
 *                                    **REPAIRING IT WOULD DESTROY A TRUE
 *                                    COMMENT ABOUT A LIVE GAP.**
 *
 *   NOT CLAIMS AT ALL — the closed-set tuples, correct and untouched:
 *     commands/session.ts:54 · harness/bootstrap-manifest.ts:79
 *     discovery/operations.ts:882 is the frozen SYN — a separate defect half
 *     (it advertises `scratch`, which the node refuses) and frozen surface.
 *
 * **WHY THE SECOND FALSE ONE IS NOT PINNED HERE, DELIBERATELY:** it is a source
 * comment read by maintainers, not by agents, and the only way to pin it is to
 * match its wording — which §8 of the W4 handoff forbids for a good reason: a
 * prose pin "goes red when an owner legitimately rewords their own file",
 * punishing the correct action. A structural pin has nothing to attach to,
 * because a comment has no behaviour. **So it is repaired under the grant and
 * verified by READING, and this file says so rather than pretending its green
 * covers it.**
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

describe('E-5 — the projection and handler now agree on the supported modes', () => {
  /**
   * The handler's own reserved mode. `execution-handlers.ts:555-557`.
   * This is the mode the projection says NOTHING about.
   */
  it('--workdir scratch reaches the handler and is not refused as unimplemented', async () => {
    const r = await spawnWith('scratch');
    measured['scratch'] = r;
    expect(r.code).not.toBe(0);
    expect(isNotImplemented(r.stderr), `unexpected not_implemented: ${r.stderr}`).toBe(false);
  });

  /**
   * 2026-08-13: THE FINDING THIS FILE PINNED IS RESOLVED. The git wave landed
   * worktree as a first-class advertised mode (`--workdir project|scratch|
   * worktree`, spawn provisions a real lane), so the old assertion — local
   * exit 2 because unadvertised — now asserts a bug that was fixed. The mode
   * is held to the same bar as `scratch`: it reaches the handler and is not
   * refused as unimplemented.
   */
  it('--workdir worktree is advertised and reaches the handler like scratch', async () => {
    const r = await spawnWith('worktree');
    measured['worktree'] = r;
    expect(r.code).not.toBe(0);
    expect(isNotImplemented(r.stderr), `unexpected not_implemented: ${r.stderr}`).toBe(false);
    // Not refused LOCALLY as an unknown mode — the old inversion, inverted.
    expect(r.code).not.toBe(2);
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
  it('the shipped projection advertises project, scratch AND worktree', () => {
    // ⚠ `DISCOVERY` IS A READONLY ARRAY, NOT A KEYED MAP (`operations.ts:1312`).
    // The raw table in that file IS keyed by operation name, and reading the
    // table led me to index the EXPORT the same way. It returned `undefined`,
    // which this test reported as "the note is gone — this finding may be
    // fixed" — a false ALL-CLEAR from a shape assumption, in the reassuring
    // direction. The in-tree idiom is `.find(...)`, per
    // `discovery-operations.test.ts:72`.
    const row = DISCOVERY.find((d) => d.operation === 'execution.spawn');
    // The projection field is `syntax` (the source table's `syn` is internal —
    // asserting on `syn` returned undefined, a false all-clear).
    expect(row?.syntax).toContain('--workdir project|scratch|worktree');
    // The contradiction this file existed to pin: a note claiming worktree is
    // unadvertised while the syntax advertises it. Neither half may return.
    expect(row?.notes.some((note) => /worktree is not advertised/.test(note))).toBe(false);
  });
});
