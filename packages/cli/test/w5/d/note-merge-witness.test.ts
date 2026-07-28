/**
 * W5 DUO D — THE ARCHIVED note-MERGE WITNESS.
 *
 * ⚠ READ THIS BEFORE READING A RESULT FROM THIS FILE ⚠
 *
 * THIS FILE LIVES UNDER `packages/cli/test/` AND ITS CENTRAL WITNESS IS NOT
 * ABOUT THE CLI. That mislabelling is deliberate, it is disclosed here, and it
 * is PINNED BY AN ASSERTION rather than by this comment — see TRIPWIRE below.
 * A caveat that lives only in a filename or a prose header is exactly what a
 * later rename deletes.
 *
 * WHY THE WITNESS CANNOT BE CLI-LEVEL TODAY. `entities.commands.work` takes
 * four inputs (`status`, `startedAt`, `note`, `clientMutationId`) and the
 * shipped CLI grammar can express TWO of them. There is no `--note` and no
 * `--started-at` on `tm8 task transition` — not a flag that cannot carry null,
 * NO FLAG AT ALL. So `note: null` is unreachable from any CLI invocation and
 * the only instrument that can drive it is raw HTTP against the real Server.
 *
 * ── THE MEASUREMENT THIS FILE ARCHIVES ────────────────────────────────────
 *
 * Run before any fix landed, against a REAL Server on REAL scratch databases
 * built from two REAL staged chains, positive control green in all six cells:
 *
 *   chain 001..036 (33 files, 5321fe908770d56f)
 *     note ABSENT   -> AFTER null          (the stored note was DESTROYED)
 *     note NULL     -> AFTER null          (the stored note was CLEARED)
 *     note "value"  -> AFTER "replaced"
 *   chain 001..037 (34 files, a799b7ef1b20a9b0)
 *     note ABSENT   -> AFTER preserved     (correct: absent means leave alone)
 *     note NULL     -> AFTER preserved     (REGRESSION: clearing became impossible)
 *     note "value"  -> AFTER "replaced"
 *
 * TWO FACTS, EACH ANSWERING A DIFFERENT HALF OF THE QUESTION, because reporting
 * either alone is a measurement described in language wider than itself:
 *
 *   THE SYMPTOM — "note:null is accepted with 200 and silently does nothing" —
 *   IS A REGRESSION 037 INTRODUCED. At chain 036 that exact request CLEARED the
 *   note, from a proven non-null BEFORE. The clear half was API-REACHABLE.
 *
 *   THE DEFECT — absent and explicit-null are indistinguishable — IS
 *   PRE-EXISTING and 037 left it untouched. Both chains collapse them
 *   identically, because the collapse is `input.note ?? null` at
 *   `packages/server/src/facade/handlers/commands.ts:38`, upstream of SQL.
 *
 * So 037 is NOT a half-done fix. It is a COMPLETE fix applied at a layer where
 * the distinction it needed had ALREADY BEEN DESTROYED: no migration could fix
 * one input without breaking the other, because both arrive as one wire value.
 * The worked correct example is twelve files away at
 * `packages/server/src/facade/handlers/w2/messages-handoffs.ts:377-379`
 * (`input.mentions === undefined ? null : …`), which keeps the distinction
 * alive at the layer where the distinction still exists.
 *
 * ── WHY THESE ASSERTIONS ARE NOT SOFTENED TO MATCH THE DEFECT ─────────────
 *
 * `explicit null must clear` is RED as this file is written. It asserts the
 * CONTRACT-CORRECT outcome — `WorkInputSchema` at
 * `packages/contract/src/schemas.ts:972-977` declares
 * `note: z.string().nullable().optional()`, which is genuinely THREE-STATE, so
 * explicit null is schema-valid and reaches the handler. It will go GREEN ON
 * ITS OWN when the server preserves the distinction, with no edit here. A
 * softened assertion would be green today and would fail the day the bug was
 * repaired. Two witnesses in the previous wave did exactly this and both paid
 * off. If you believe this red is wrong, ARGUE IT — do not edit it.
 *
 * BOTH HALVES ARE GATED, and a fix that satisfies only one is not a fix:
 *   absent        -> LEAVE ALONE   (green today; must not regress to destroy)
 *   explicit null -> CLEAR         (red today; must be restored)
 * A fix that clears on both trades a silent-cannot-erase straight back for a
 * silent-destroy, which is the trade W4's handoff §9 named in advance.
 *
 * POSITIVE CONTROL IS NOT OPTIONAL HERE. "the note is null afterwards" is
 * equally consistent with "there was never a note", so every cell stores a note
 * and proves it READABLE before sending the thing under test. Without that this
 * suite could report a wipe that never happened.
 */
import { vi, afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertBuilt, cli, startRealServer, type RealServer } from '../../integration/harness.js';

/**
 * ⚠ EXPLICIT TIMEOUTS FOR BOTH KINDS OF HOOK AND FOR EVERY TEST.
 *
 * vitest ships TWO independent defaults and this suite exceeded BOTH under load:
 *   testTimeout 5s   -> "Test timed out in 5000ms", a NAMED test failure
 *   hookTimeout 10s  -> "Hook timed out in 10000ms", an UNNAMED file-level abort
 * A generous `beforeAll` argument covers NEITHER; they are separate settings.
 *
 * THE FAILURE MODE IS LOAD-SENSITIVE, WHICH IS WHAT MAKES IT DANGEROUS. These
 * tests ran in 1195ms / 1102ms / 507ms at load 13.7 and BLEW A 5s CEILING at
 * load 30.0 — same tree, same binary, same assertions. So it is invisible on an
 * idle machine and fires exactly inside a busy migration gate, where it is
 * attributed to whatever landed rather than to the clock.
 *
 * Each `it` spawns SEVERAL built-CLI child processes against a real Server;
 * `node` start-up alone is most of a second per invocation on a loaded host.
 * Matching the in-tree precedent at `test/integration/inbox.test.ts:39`.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });


let server: RealServer;
let spaceId = '';

beforeAll(async () => {
  await assertBuilt();
  server = await startRealServer('w5d-note');
  process.stderr.write(
    `[w5d] ${server.baseUrl} bind-start ${server.bindStart.files}/${server.bindStart.digest}\n`,
  );
  const res = await fetch(new URL('/v2/spaces', server.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'W5 D note witness', clientMutationId: 'w5d-note-space' }),
  });
  const body = (await res.json()) as { data?: { space?: { id?: string } } };
  spaceId = body.data?.space?.id ?? '';
  if (!spaceId) throw new Error(`space setup failed (${res.status}): ${JSON.stringify(body)}`);
}, 180_000);

afterAll(async () => {
  // A throw here means the chain moved under this suite and every number above
  // is bound to two different trees — DISCARD it, do not report it.
  await server?.assertBindCoherent();
  await server?.stop();
  // ⚠ THE EXPLICIT TIMEOUT IS LOAD-BEARING, and its absence already cost a run.
  // vitest's DEFAULT HOOK TIMEOUT IS 10s, and it applies to `afterAll` even
  // when `beforeAll` was given a generous one — they are configured
  // separately. Teardown here kills a real Server child, waits for its exit,
  // removes a data directory and DROPS A DATABASE, which does not reliably fit
  // in 10s on a loaded host. It surfaced as `Hook timed out in 10000ms` with
  // ALL FIVE TESTS PASSING — a suite-level FAIL produced entirely by teardown,
  // which reads exactly like a real failure to anything counting failed files.
}, 120_000);

async function post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(new URL(path, server.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => undefined) };
}

/** A fresh task carrying a PROVEN-READABLE stored note. Returns its id. */
async function taskWithStoredNote(label: string): Promise<string> {
  const created = await post('/v2/entities', {
    spaceId, kind: 'task', title: `w5d note ${label}`, clientMutationId: `w5d-create-${label}`,
  });
  const id = (created.body as { data?: { entity?: { id?: string } } }).data?.entity?.id;
  if (id === undefined) {
    throw new Error(`entity create failed (${created.status}): ${JSON.stringify(created.body)}`);
  }
  await post(`/v2/entities/${id}/commands/work`, {
    status: 'working', note: STORED, clientMutationId: `w5d-store-${label}`,
  });
  // THE POSITIVE CONTROL, asserted rather than assumed: without it, every
  // "AFTER is null" below is equally consistent with "there was never a note".
  expect(await noteOf(id), 'POSITIVE CONTROL: the note must be stored and readable BEFORE the test')
    .toBe(STORED);
  return id;
}

const STORED = 'handover: waiting on review';

/**
 * The stored note as the WIRE reports it.
 *
 * `undefined` and `null` are NOT interchangeable here and must not be
 * collapsed: `undefined` means the `workingActors` entry itself is gone (a
 * different defect entirely), `null` means the entry survives with a cleared
 * note. Reading these as the same value would report a wipe for a vanished row.
 */
async function noteOf(id: string): Promise<string | null | undefined> {
  const res = await fetch(new URL(`/v2/entities/${id}`, server.baseUrl));
  const body = (await res.json()) as {
    data?: { badges?: { workingActors?: Array<{ note?: string | null }> } };
  };
  const actors = body.data?.badges?.workingActors;
  if (actors === undefined || actors.length === 0) return undefined;
  return actors[0]?.note;
}

describe('TRIPWIRE — what makes this file honest about its own scope', () => {
  /**
   * ⚠ THIS ASSERTION IS THE LABEL. It is not a convenience check.
   *
   * The witness below is API-LEVEL and lives in a CLI test directory. The
   * ONLY thing that makes that honest rather than misleading is that the CLI
   * genuinely cannot drive it — and that is a fact about the world, so it will
   * expire without notice, which is precisely the class W4 §6 could not solve
   * for prose.
   *
   * So it is asserted instead of written down. THE DAY THE CLI GAINS `--note`,
   * THIS TEST GOES RED and forces a reader back into this file to upgrade the
   * witness from API-level to CLI-level. A rename cannot delete it and a
   * skim cannot miss it.
   *
   * Driven against the BUILT BINARY, not in-process: the claim is about what
   * an agent invoking `tm8` can express, and only the binary answers that.
   */
  it('the shipped CLI cannot express `note` AT ALL — so the witness below is API-LEVEL, not CLI-level', async () => {
    const ran = await cli(
      ['task', 'transition', '00000000-0000-7000-8000-000000000000', 'working', '--note', 'x'],
      server,
    );
    expect(ran.code, 'exit 2 = usage. If this is no longer 2, the CLI gained a --note flag').toBe(2);
    expect(ran.stderr).toContain('has no --note');
  });

  /**
   * The same fact for `startedAt`, the SECOND unexpressible input of the same
   * four-input command. Recorded separately so closing one does not silently
   * appear to close both — `commands.ts:36` passes `input.startedAt` and
   * `:38` passes `input.note`, and the CLI can send neither.
   */
  it('the shipped CLI cannot express `startedAt` either — two of four inputs are unreachable', async () => {
    const ran = await cli(
      ['task', 'transition', '00000000-0000-7000-8000-000000000000', 'working', '--started-at', '2026-01-01T00:00:00Z'],
      server,
    );
    expect(ran.code).toBe(2);
    expect(ran.stderr).toContain('has no --started-at');
  });
});

describe('API-LEVEL WITNESS (raw HTTP, NOT the CLI) — absent means leave alone, explicit null means clear', () => {
  /**
   * GREEN TODAY. This is the known-good half of the detector: without it, a
   * "fix" that cleared on BOTH inputs would satisfy the red below while
   * reintroducing the silent-destroy that 037 removed. A detector that only
   * has a red half fires on everything and passes a mutation test exactly as
   * well as a correct one.
   */
  it('ABSENT note LEAVES THE STORED NOTE ALONE (green today — a fix must not regress this)', async () => {
    const id = await taskWithStoredNote('absent');
    const sent = await post(`/v2/entities/${id}/commands/work`, {
      status: 'in_review', clientMutationId: `w5d-absent-${id}`,
    });
    expect(sent.status).toBe(200);
    expect(await noteOf(id)).toBe(STORED);
  });

  /**
   * ⚠ RED AS WRITTEN, DELIBERATELY, ASSERTING THE CONTRACT-CORRECT OUTCOME.
   *
   * This exact request CLEARED the note at chain 001..036 and stopped doing so
   * at 037. It is a REGRESSION, not a missing feature, and the archived
   * measurement above is the evidence — it cannot be re-captured once the fix
   * lands without re-staging a chain outside the repository.
   *
   * DO NOT SOFTEN THIS TO `toBe(STORED)` TO GET A GREEN. That would pass today
   * and fail the day the server is repaired.
   */
  it('EXPLICIT null CLEARS the stored note (RED today — regression introduced by 037)', async () => {
    const id = await taskWithStoredNote('explicit-null');
    const sent = await post(`/v2/entities/${id}/commands/work`, {
      status: 'in_review', note: null, clientMutationId: `w5d-null-${id}`,
    });
    expect(sent.status, 'explicit null is schema-valid — it must be ACCEPTED, not 400').toBe(200);
    expect(
      await noteOf(id),
      'explicit null must CLEAR. `null` here means the workingActors row survives with no note; ' +
        '`undefined` would mean the row itself vanished, which is a different defect.',
    ).toBeNull();
  });

  /**
   * The third state, asserted so the other two cannot both pass by the write
   * path being broken outright. If this ever fails, the two results above
   * carry no information about absent-versus-null at all.
   */
  it('an explicit VALUE replaces the stored note (control: the write path works)', async () => {
    const id = await taskWithStoredNote('value');
    await post(`/v2/entities/${id}/commands/work`, {
      status: 'in_review', note: 'replaced', clientMutationId: `w5d-value-${id}`,
    });
    expect(await noteOf(id)).toBe('replaced');
  });
});
