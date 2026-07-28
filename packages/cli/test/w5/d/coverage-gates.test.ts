/**
 * W5 DUO D — GATING WHAT W4 DECLARED UNIT-ONLY, AND THE SAVED-VIEW ROUND TRIP.
 *
 * REAL SERVER. This suite spawns the production binary on an isolated,
 * freshly-migrated scratch database and talks to it over HTTP through the BUILT
 * CLI, the way an agent does. It is the duo's real-Server evidence; the
 * recorder-based claims live in `wire-honesty.test.ts` and are kept separate
 * because they answer a different question with a different instrument.
 *
 * ── WHAT W4 LEFT UNGATED ON THIS DUO'S SURFACE ────────────────────────────
 *
 * W4's per-operation coverage declaration (evidence §15.2) is the program's
 * entire coverage record, and for groups 2/3/4/6/7 it names exactly four
 * shortfalls. Searched with `-a`, because one of the files involved is
 * invisible to a plain grep on this machine:
 *
 *   group 4  `placement apply … subtask` — UNIT-ONLY. The stated reason is
 *            "shares one code path with `reparent`, declared not implied".
 *            THAT REASON IS EXACTLY WHY IT NEEDS DRIVING: "shares a code path"
 *            is a claim about the implementation, and the whole point of a
 *            declaration is that it is measured rather than inferred. W4 was
 *            right to declare it rather than fold it into `reparent`'s green.
 *   group 6  `bridge.fetchBlob` — reserved by contract, no command exists.
 *   group 7  `inbox.markRead` — REFUSAL path only; a real notification is
 *            minted by a trigger outside that slot.
 *   group 2  two pagination PATHS unexercised — a single-member fixture cannot
 *            produce a second page, and awards are unreachable.
 *
 * ── AND THE ORDERED PROBE ─────────────────────────────────────────────────
 *
 * Every expressibility measurement so far proves a flag is REFUSED, and an
 * ABSENCE is the weakest evidence this program handles. The saved-view round
 * trip demonstrates a CONSEQUENCE instead: this CLI can CREATE a saved view
 * carrying `layout`/`groupBy`/`sort`/`filters`/`parentId`, and CANNOT REPLAY
 * it — the two halves of one round trip, in one package, over identical frozen
 * shapes. `contract/src/catalog.ts` carries exactly four `savedViews` rows
 * (list, create, update, delete), so NO operation executes a saved view for any
 * client; the only permitted execution path is read-the-view then feed its
 * query to `collections.query`, which is precisely the half that cannot carry
 * those fields.
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
  server = await startRealServer('w5d-gates');
  process.stderr.write(
    `[w5d-gates] ${server.baseUrl} bind-start ${server.bindStart.files}/${server.bindStart.digest}\n`,
  );
  const res = await fetch(new URL('/v2/spaces', server.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'W5 D coverage gates', clientMutationId: 'w5d-gates-space' }),
  });
  const body = (await res.json()) as { data?: { space?: { id?: string } } };
  spaceId = body.data?.space?.id ?? '';
  if (!spaceId) throw new Error(`space setup failed (${res.status}): ${JSON.stringify(body)}`);
}, 180_000);

afterAll(async () => {
  await server?.assertBindCoherent();
  await server?.stop();
  // See the note in `note-merge-witness.test.ts`: vitest's default HOOK timeout
  // is 10s and is configured independently of `beforeAll`'s. Real-Server
  // teardown drops a database and does not reliably fit inside it.
}, 120_000);

/** The built binary, pointed at THIS run's Server. Never the default 4610. */
async function tm8(argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return await cli([...argv], server, { TM8_SPACE_ID: spaceId });
}

async function tm8Json<T>(argv: readonly string[]): Promise<{ code: number; data: T; stderr: string }> {
  const r = await tm8([...argv, '--format', 'json']);
  return {
    code: r.code,
    stderr: r.stderr,
    data: (r.stdout ? (JSON.parse(r.stdout) as T) : undefined) as T,
  };
}

/** A task, created through the shipped CLI so setup is itself evidence. */
async function newTask(title: string): Promise<string> {
  const r = await tm8Json<{ entity?: { id?: string } }>(['entity', 'create', 'task', title]);
  const id = r.data?.entity?.id;
  if (id === undefined) throw new Error(`entity create failed (${r.code}): ${r.stderr}`);
  return id;
}

describe('GROUP 4 — `placement apply … subtask`, declared UNIT-ONLY by W4 §15.2', () => {
  /**
   * W4 declared this rather than folding it into `reparent`'s green, on the
   * stated grounds that the two share one code path. Driving it against a real
   * Server is what converts "shares a code path" from an implementation claim
   * into a measured one.
   *
   * BOTH INTENTS ARE DRIVEN, not just the unproven one: if `reparent` were also
   * broken, a lone `subtask` red would carry no information about `subtask`.
   */
  it('subtask reaches a real Server and is applied (the UNIT-ONLY row, now exercised)', async () => {
    const parent = await newTask('w5d subtask parent');
    const child = await newTask('w5d subtask child');

    const r = await tm8(['placement', 'apply', child, 'subtask', parent]);
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);

    // The CONSEQUENCE, not merely the exit code: the child must now hang off
    // the parent. An exit 0 that changed nothing is the failure mode this
    // program has hit repeatedly.
    const kids = await tm8Json<{ items?: Array<{ id?: string }> }>(['entity', 'children', parent]);
    expect(kids.code, kids.stderr).toBe(0);
    expect(
      (kids.data?.items ?? []).map((i) => i.id),
      'subtask must actually reparent the child — exit 0 alone is not the claim',
    ).toContain(child);
  });

  it('reparent — the intent W4 DID exercise — still works (control for the row above)', async () => {
    const parent = await newTask('w5d reparent parent');
    const child = await newTask('w5d reparent child');
    const r = await tm8(['placement', 'apply', child, 'reparent', parent]);
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
  });
});

describe('GROUP 6 — `bridge.fetchBlob` has no command, and that must stay TRUE-BY-ABSENCE', () => {
  /**
   * W4 recorded this as not-covered because the contract RESERVES it and no
   * command exists. That is a legitimate disposition, and it is exactly the
   * kind of claim that rots silently: the day someone binds a command, the
   * prose stays and the reason expires.
   *
   * So it is asserted structurally rather than described. This is the same
   * shape as the note-witness TRIPWIRE — a fact about the world, pinned so it
   * cannot quietly stop being true.
   */
  it('no CLI command binds bridge.fetchBlob (red the day one does — then re-gate it)', async () => {
    const { DISCOVERY } = await import('../../../src/discovery/operations.js');
    const row = DISCOVERY.find((d) => d.operation === 'bridge.fetchBlob');
    expect(row, 'sanity: the operation must exist in the projection at all').toBeDefined();
    expect(
      row?.command,
      'bridge.fetchBlob gained a command. W4 declared it NOT-COVERED because none existed; ' +
        'that reason has now expired and the row needs real coverage rather than this assertion.',
    ).toBeNull();
  });
});

describe('GROUP 7 — `inbox.markRead`: W4 exercised the REFUSAL path only', () => {
  /**
   * Stated at the width the measurement supports: this drives the refusal and
   * reports whether the SUCCESS path is reachable from a CLI-only fixture. W4's
   * reason — notifications are minted by a trigger outside that slot — is
   * re-derived here rather than inherited, because a reason that is quoted and
   * never re-checked is how this program's stale examples propagate.
   */
  it('refuses an unknown notification id against a real Server (the path W4 covered)', async () => {
    const r = await tm8(['inbox', 'mark-read', '019fa297-64e3-7000-8000-0000000000ff']);
    expect(r.code, `stderr: ${r.stderr}`).not.toBe(0);
    // EXIT 8 HAS TWO CAUSES and they are distinguishable only by stderr text:
    // run.ts's "not implemented in this CLI build" versus the Server's honest
    // 501. This must be neither — the command is wired and the Server answers.
    expect(r.stderr).not.toContain('not implemented in this CLI build');
  });

  it('REPORTS whether a notification can be minted from a CLI-only fixture (coverage fact, not a pass)', async () => {
    const list = await tm8Json<{ items?: unknown[] }>(['inbox', 'list']);
    expect(list.code, list.stderr).toBe(0);
    const n = (list.data?.items ?? []).length;
    process.stderr.write(
      `[w5d-gates] inbox notifications reachable from a CLI-only single-member fixture: ${n}. ` +
        `${n === 0 ? 'SUCCESS PATH REMAINS UNEXERCISED — W4\'s stated mechanism re-derived, not inherited.' : 'SUCCESS PATH IS NOW REACHABLE — gate it.'}\n`,
    );
    // Asserting only that the read works. Asserting n === 0 would pin an
    // accident of the fixture and go red the day notifications become
    // reachable, which is the outcome we WANT rather than a failure.
    expect(Array.isArray(list.data?.items)).toBe(true);
  });
});

/**
 * ⚠ THE ORDERED PROBE — A BROKEN ROUND TRIP, DEMONSTRATED RATHER THAN INFERRED.
 *
 * `savedViews.create`'s nested `query` and `collections.query`'s top-level shape
 * are THE SAME TEN FIELDS. `saved-view create --query <json-source>` accepts all
 * ten as raw JSON; `entity query` can express neither `layout`, `groupBy`,
 * `sort`, `filters` nor `parentId`.
 *
 * A DELIBERATE "this CLI does not expose layout" WOULD HAVE EXCLUDED IT FROM THE
 * SAVED-VIEW JSON TOO. It did not — which is the evidence that this is an
 * oversight rather than a design choice, and it is a fact about the composed
 * surface rather than about either command alone.
 */
describe('THE SAVED-VIEW ROUND TRIP — this CLI can STORE a query it cannot REPLAY', () => {
  const QUERY = {
    kinds: ['task'],
    layout: 'board',
    sort: 'position',
    filters: { readyToPull: true },
  };

  it('POSITIVE CONTROL — the view is created AND reads back carrying the unreplayable fields', async () => {
    // Without this, "the round trip cannot complete" is equally consistent with
    // "the view was never stored", which is the trap that makes this probe
    // worth doing properly rather than quickly.
    const created = await tm8Json<{ id?: string }>([
      'saved-view', 'create', 'w5d round trip', '--share', 'private', '--query', JSON.stringify(QUERY),
    ]);
    expect(created.code, `create failed: ${created.stderr}`).toBe(0);

    // ⚠ `savedViews.list` is a BARE ARRAY, not a `Page<T>` — it is one of the
    // few rows the contract genuinely specifies as UNPAGINATED, so there is no
    // `items` wrapper to read. Measured off the real response: an earlier
    // version of this test read `.items`, got `undefined`, and reported the
    // POSITIVE CONTROL as failed — i.e. it very nearly filed "the view was not
    // stored" when the view was stored perfectly and the TEST was wrong.
    // That is what the positive control is for, and it caught its own author.
    const listed = await tm8Json<Array<{ name?: string; query?: Record<string, unknown> }>>(
      ['saved-view', 'list'],
    );
    expect(listed.code, listed.stderr).toBe(0);
    expect(Array.isArray(listed.data), '`saved-view list` answers a bare array, not a page').toBe(true);
    const mine = (listed.data ?? []).find((v) => v.name === 'w5d round trip');
    expect(mine, 'the saved view must be readable back before its replay is tested').toBeDefined();
    process.stderr.write(`[w5d-gates] stored saved-view query: ${JSON.stringify(mine?.query)}\n`);
    expect(
      mine?.query,
      'the STORED query must carry the fields whose replay is under test',
    ).toMatchObject({ layout: 'board', sort: 'position' });
  });

  it('⚠ THE DEFECT — no CLI command can execute that stored view', async () => {
    // Half one: there is no execution command at all. `saved-view` is exactly
    // list/create/update/delete, and `savedViews.list` returns the VIEWS, not
    // their results.
    const { DISCOVERY } = await import('../../../src/discovery/operations.js');
    const savedViewCommands = DISCOVERY
      .filter((d) => d.command?.[0] === 'saved-view')
      .map((d) => d.command?.join(' '))
      .sort();
    expect(
      savedViewCommands,
      'If an execution command appears here, THE ROUND TRIP IS FIXED — retire this test, do not relax it.',
    ).toEqual(['saved-view create', 'saved-view delete', 'saved-view list', 'saved-view update']);

    // Half two: the only permitted replay path — feed the query to
    // `entity query` — cannot carry the fields the view legitimately stores.
    const layout = await tm8(['entity', 'query', '--layout', 'board']);
    expect(layout.code, 'the replay path refuses `layout`').toBe(2);
    expect(layout.stderr).toContain('has no --layout');

    const sort = await tm8(['entity', 'query', '--sort', 'position']);
    expect(sort.code, 'and refuses `sort`').toBe(2);
    expect(sort.stderr).toContain('has no --sort');
  });

  it('and the round trip DOES complete for a field both halves can express (control)', async () => {
    // `kinds` is in the same stored shape and IS expressible via `--kind`, so
    // the break above is specific to five fields rather than a property of
    // saved views in general. Without this, "saved views cannot be replayed"
    // would be stated wider than the measurement.
    const r = await tm8(['entity', 'query', '--kind', 'task']);
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
  });
});
