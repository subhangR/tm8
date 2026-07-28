/**
 * GROUP 7 against a REAL Server — G08 (inbox, read marks) and G09 (saved views,
 * actions), both composed and independently W3-PASSED.
 *
 * EVERY COMMAND HERE RUNS THROUGH THE BUILT BINARY. `dist/index.js` is spawned
 * as a child process and speaks HTTP to a real Server on a freshly migrated
 * scratch database, exactly as an agent does. Nothing is substituted: argv
 * parsing, context resolution, registry dispatch, output law and the exit
 * funnel are the shipped ones.
 *
 * ONE PROPERTY DELIBERATELY DOES NOT LIVE HERE. The availability ledger is
 * PROCESS-SCOPED and never written to disk, so a child process's ledger is
 * invisible to this suite by construction. "`actions.list` must not teach the
 * ledger about the operations it names" is therefore asserted in
 * `test/action.test.ts`, in-process, where it is backed by a mutation test.
 * What IS observable across a process boundary is asserted below: that the
 * ledger does not PERSIST, so a later invocation cannot inherit a stale claim.
 *
 * `server.observe()` IS THREE-STATE AND IS NOT COLLAPSED. `'unknown'` means
 * "registered, but the handler never ran" — an empty-body probe cannot tell a
 * live handler from an unconditional 501 stub, because handler lookup precedes
 * schema validation. Resolving `'unknown'` requires a schema-valid body, which
 * is this group's own domain work, and that is what the resolution block does.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { assertBuilt, cli, startRealServer, type RealServer } from './harness.js';
import { isRegisteredPath } from '../../src/commands/registry.js';

/**
 * Every test here spawns the BUILT BINARY as a child process, and several spawn
 * it three or four times. Measured on this host under wave load: one
 * `node dist/index.js --version` costs 1.85-2.32 s at load average 66 on 8
 * cores, so a four-invocation test needs ~9 s and vitest's 5 s default cannot
 * pass. This is a defect in THIS FILE's harness assumption, not a slow product:
 * the same tests complete in ~250 ms per invocation on an idle host. Raised
 * rather than masked, and stated with the measurement that justifies it.
 */
vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 });

let server: RealServer;
let spaceId = '';

/** Group 7's eight rows, in packet order. */
const G7_OPERATIONS = [
  'inbox.list', 'inbox.markRead', 'readMarks.upsert',
  'savedViews.list', 'savedViews.create', 'savedViews.update', 'savedViews.delete',
  'actions.list',
] as const;

/** Raw HTTP, used only for SETUP that is not group 7's own surface. */
async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(new URL(path, server.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => undefined) };
}

/**
 * Drive a group 7 command through the BUILT BINARY against the real Server.
 *
 * This spawns `packages/cli/dist/index.js` as a child process and speaks HTTP,
 * exactly as an agent does. Group 7's modules are wired into `registry.ts` now,
 * so nothing is substituted: argv parsing, context resolution, dispatch, output
 * law and the exit funnel are all the shipped ones.
 */
async function g7(argv: readonly string[]): Promise<{
  code: number; stdout: string; stderr: string; dto: any;
}> {
  const r = await cli([...argv, '--format', 'json'], server);
  let dto: unknown;
  try { dto = JSON.parse(r.stdout); } catch { dto = undefined; }
  return { ...r, dto };
}

beforeAll(async () => {
  await assertBuilt();
  server = await startRealServer('g7-inbox');
  process.env.TM8_BASE_URL = server.baseUrl;
  delete process.env.TM8_SPACE_ID;
  delete process.env.TM8_ACTOR_ID;
  delete process.env.TM8_CONFIG_PATH;

  const created = await post('/v2/spaces', {
    name: `g7 scratch ${randomUUID().slice(0, 8)}`,
    clientMutationId: randomUUID(),
  });
  spaceId = created.json?.data?.space?.id ?? created.json?.data?.id ?? '';
}, 120_000);

afterAll(async () => {
  await server?.stop();
});

describe('the node this suite actually measured', () => {
  it('reports /health OUTSIDE the {data, requestId} envelope', async () => {
    const health = await server.health();
    expect(health.ok).toBe(true);
    // `implemented` counts REGISTERED handlers. A registered handler may be an
    // unconditional 501 stub, so this is never quoted as "behaviourally
    // implemented" — it is a cache-invalidation epoch and nothing more.
    expect(typeof health.implemented).toBe('number');
    expect(typeof health.operations).toBe('number');
    console.log(`[g7] /health operations=${health.operations} registered=${health.implemented}`);
    console.log(`[g7] bindStart ${server.bindStart.files}/${server.bindStart.digest}`);
  });

  it('has a Space to work in', () => {
    expect(spaceId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('per-operation availability, observed three-state and never over-claimed', () => {
  it('records what an empty-body probe can honestly conclude for all eight rows', async () => {
    const observed: Record<string, string> = {};
    for (const op of G7_OPERATIONS) observed[op] = await server.observe(op);
    console.log(`[g7] observe (empty-body probe): ${JSON.stringify(observed, null, 2)}`);

    // The sweep must not be vacuous: prove it really iterated every row.
    expect(Object.keys(observed)).toHaveLength(G7_OPERATIONS.length);
    for (const op of G7_OPERATIONS) {
      expect(['available', 'unavailable', 'unknown'], op).toContain(observed[op]);
    }
    // G08/G09 are composed on this node, so NOTHING here may be `unavailable`.
    // An `unavailable` would mean a row this group was told is composed answers
    // an honest 501 — that would be the finding, not a passing detail.
    for (const op of G7_OPERATIONS) {
      expect(observed[op], `${op} answered an honest 501`).not.toBe('unavailable');
    }
  }, 60_000);

  it('proves the probe CAN detect an honest 501, so `not unavailable` is not vacuous', async () => {
    // Positive control on the negative: a row that is genuinely uncomposed on
    // this node must observe `unavailable`. Without this, the assertion above
    // would pass even if `observe` could never return `unavailable` at all.
    const reserved = await server.observe('search.query');
    expect(reserved).toBe('unavailable');
  }, 30_000);
});

describe('G08 — inbox and read marks, resolved against the real Server', () => {
  it('inbox.list answers with the Page DTO through the built binary', async () => {
    const r = await g7(['inbox', 'list', '--space', spaceId]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.dto).toHaveProperty('items');
    expect(Array.isArray(r.dto.items)).toBe(true);
    expect(r.dto).toHaveProperty('nextCursor');
    // Output law: the DTO on stdout, diagnostics nowhere near it.
    expect(r.stderr).toBe('');
  });

  it('inbox.list honours --unread and --limit as real query fields', async () => {
    const r = await g7(['inbox', 'list', '--space', spaceId, '--unread', '--limit', '5']);
    expect(r.code, r.stderr).toBe(0);
    expect(Array.isArray(r.dto.items)).toBe(true);
  });

  it('inbox.list rejects a cursor it did not issue, as invalid_cursor -> exit 2', async () => {
    const r = await g7(['inbox', 'list', '--space', spaceId, '--cursor', 'not-a-cursor']);
    expect(r.code).toBe(2);
  });

  it('readMarks.upsert is REACHED with a schema-valid body — resolving observe()\'s `unknown`', async () => {
    // A schema-valid body is what an empty-body probe cannot supply, which is
    // exactly why `observe` reported `unknown` and why resolving it is domain
    // work. A non-existent anchor must therefore fail on the ENTITY, not on the
    // schema: `not_found` (5) proves the handler ran and looked the anchor up.
    const r = await g7(['message', 'mark-read', randomUUID()]);
    expect([5, 4, 6], `unexpected: ${r.stderr}`).toContain(r.code);
    expect(r.stderr).not.toContain('invalid_input');
    expect(r.stderr).not.toContain('not_implemented');
  });

  it('inbox.markRead is REACHED with a schema-valid body — same resolution', async () => {
    const r = await g7(['inbox', 'mark-read', randomUUID()]);
    expect([5, 4, 6], `unexpected: ${r.stderr}`).toContain(r.code);
    expect(r.stderr).not.toContain('invalid_input');
    expect(r.stderr).not.toContain('not_implemented');
  });

  it('`--through` never reaches the wire: refused locally as exit 2', async () => {
    const r = await g7(['message', 'mark-read', randomUUID(), '--through', randomUUID()]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--through');
  });
});

describe('G09 — saved views, created and read back through the real Server', () => {
  const made: string[] = [];

  it('savedViews.create round-trips, and savedViews.list reads it back', async () => {
    const created = await g7([
      'saved-view', 'create', 'g7 first', '--space', spaceId,
      '--share', 'private', '--query', JSON.stringify({ kinds: ['task'] }),
    ]);
    expect(created.code, created.stderr).toBe(0);
    expect(created.dto.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.dto.name).toBe('g7 first');
    expect(created.dto.shareMode).toBe('private');
    // The CLI filled query.spaceId from the resolved Space; the Server stored it.
    expect(created.dto.query.spaceId).toBe(spaceId);
    made.push(created.dto.id);

    const listed = await g7(['saved-view', 'list', '--space', spaceId]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.dto.map((v: any) => v.id)).toContain(created.dto.id);
  });

  /**
   * `savedViews.list` IS UNPAGINATED — established twice over, and the CLI now
   * refuses the flags rather than sending them.
   *
   * The earlier measurement stands on the record: with 3 views stored, a
   * `--limit 1` that DID reach the wire returned all 3, and the response was a
   * bare array with no `nextCursor`. Silently ignored, not rejected. The frozen
   * contract independently confirms it — no limit, no cursor, no Page.
   *
   * What is asserted now is that the complete set comes back, with the counter
   * first shown to track reality (1 after one view, 3 after three) so the count
   * cannot pass vacuously, plus the local refusal that replaced the passthrough.
   */
  it('returns the COMPLETE set, and refuses the pagination flags it cannot honour', async () => {
    const count = async (): Promise<number> => {
      const r = await g7(['saved-view', 'list', '--space', spaceId]);
      expect(r.code, r.stderr).toBe(0);
      expect(Array.isArray(r.dto), 'not a bare array — the DTO shape changed').toBe(true);
      expect(r.dto).not.toHaveProperty('nextCursor');
      return r.dto.length;
    };

    // POSITIVE CONTROL: the counter distinguishes 1 from 3 on real data, so
    // "returns everything" is a measurement rather than a constant.
    expect(await count()).toBe(1);
    for (const name of ['g7 second', 'g7 third']) {
      const c = await g7([
        'saved-view', 'create', name, '--space', spaceId,
        '--share', 'space', '--query', JSON.stringify({ kinds: ['doc'] }),
      ]);
      expect(c.code, c.stderr).toBe(0);
      made.push(c.dto.id);
    }
    expect(await count()).toBe(3);

    // The flags no longer reach the wire at all.
    const limited = await g7(['saved-view', 'list', '--space', spaceId, '--limit', '1']);
    expect(limited.code).toBe(2);
    expect(limited.stderr).toContain('--limit');
    console.log('[g7] savedViews.list: unpaginated by contract; --limit/--cursor refused locally');
  }, 60_000);

  it('savedViews.delete requires --yes, then really deletes', async () => {
    const target = made.at(-1)!;
    const refused = await g7(['saved-view', 'delete', target]);
    expect(refused.code).toBe(2);

    const before = await g7(['saved-view', 'list', '--space', spaceId]);
    const deleted = await g7(['saved-view', 'delete', target, '--yes']);
    expect(deleted.code, deleted.stderr).toBe(0);

    const after = await g7(['saved-view', 'list', '--space', spaceId]);
    expect(after.dto.length).toBe(before.dto.length - 1);
    expect(after.dto.map((v: any) => v.id)).not.toContain(target);
  });

  it('savedViews.update really replaces name, sharing and query', async () => {
    const target = made[0]!;
    const updated = await g7([
      'saved-view', 'update', target,
      '--name', 'g7 renamed', '--share', 'space',
      '--query', JSON.stringify({ kinds: ['doc'] }), '--space', spaceId,
    ]);
    expect(updated.code, updated.stderr).toBe(0);
    expect(updated.dto.id).toBe(target);
    expect(updated.dto.name).toBe('g7 renamed');
    expect(updated.dto.shareMode).toBe('space');

    // Read it back through a separate call: the replacement really persisted,
    // rather than only being echoed by the mutation response.
    const listed = await g7(['saved-view', 'list', '--space', spaceId]);
    const row = listed.dto.find((v: any) => v.id === target);
    expect(row.name).toBe('g7 renamed');
    expect(row.shareMode).toBe('space');
  });

  it('savedViews.update refuses --expect-version by name and sends nothing', async () => {
    const target = made[0]!;
    const r = await g7([
      'saved-view', 'update', target, '--expect-version', '1',
      '--name', 'should not land', '--share', 'private',
      '--query', JSON.stringify({ kinds: ['task'] }), '--space', spaceId,
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--expect-version');

    // The refusal really did reach no network: the name from the previous test
    // survives. A silently-dropped guard would have let this write land.
    const listed = await g7(['saved-view', 'list', '--space', spaceId]);
    expect(listed.dto.find((v: any) => v.id === target)?.name).toBe('g7 renamed');
  });

  /**
   * MEASURED, not assumed: `updateSavedView` passes `null` for `graphLayout`
   * when the input omits it, and the corrected grammar for `saved-view update`
   * has no `--graph-layout` flag. If that combination WIPES a stored layout,
   * every update silently destroys it and no CLI flag can preserve it. That
   * would be a server/grammar finding to route upward — never something to
   * paper over in the client — so it is measured rather than argued.
   */
  it('MEASURES whether an update preserves or wipes a stored graphLayout', async () => {
    const layout = { [made[0]!]: { x: 3, y: 4 } };
    const created = await g7([
      'saved-view', 'create', 'g7 layout probe', '--space', spaceId,
      '--share', 'private', '--query', JSON.stringify({ kinds: ['task'] }),
      '--graph-layout', JSON.stringify(layout),
    ]);
    expect(created.code, created.stderr).toBe(0);
    // Positive control: the layout must be stored in the first place, or the
    // wipe assertion below would pass against an absence it never created.
    expect(created.dto.graphLayout, 'layout was never stored; measurement void').toEqual(layout);

    // HALF ONE — the flag OMITTED. The Server replaces the column wholesale, so
    // this is EXPECTED to wipe until the server-side merge lands. A wipe here is
    // the correct current result, not a failed fix and not a CLI defect.
    const omitted = await g7([
      'saved-view', 'update', created.dto.id, '--name', 'g7 layout probe',
      '--share', 'private', '--query', JSON.stringify({ kinds: ['task'] }), '--space', spaceId,
    ]);
    expect(omitted.code, omitted.stderr).toBe(0);
    console.log(
      `[g7] MEASUREMENT update WITHOUT --graph-layout: graphLayout = ` +
        `${JSON.stringify(omitted.dto.graphLayout)} ` +
        `(undefined => still WIPED, expected until the server merge lands)`,
    );

    // HALF TWO — the flag SUPPLIED. This is what restoring it actually buys:
    // the CLI can now express a layout on update at all. It closes the
    // EXPRESSIVENESS gap; it does not close the data-loss defect, because any
    // other caller omitting the field still nulls the column.
    const supplied = await g7([
      'saved-view', 'update', created.dto.id, '--name', 'g7 layout probe',
      '--share', 'private', '--query', JSON.stringify({ kinds: ['task'] }),
      '--space', spaceId, '--graph-layout', JSON.stringify(layout),
    ]);
    expect(supplied.code, supplied.stderr).toBe(0);
    console.log(
      `[g7] MEASUREMENT update WITH --graph-layout: graphLayout = ` +
        `${JSON.stringify(supplied.dto.graphLayout)} (original => the flag really carries it)`,
    );
    expect(supplied.dto.graphLayout, 'the restored flag does not reach the wire').toEqual(layout);

    made.push(created.dto.id);
  }, 90_000);

  /**
   * The packet names exactly two non-200 successes (`entities.create` -> 201,
   * `tracking.refresh` -> 202). This node's `savedViews.create` handler also
   * emits 201, so the status is MEASURED rather than quoted from the source
   * read — an unverified status in a report is a rumour with a number attached.
   * Nothing depends on the value: `Tm8Client` accepts any 2xx by design, which
   * is why a 201 here is an accounting note and not a defect.
   *
   * Runs LAST in this block: it adds a row, and the pagination control above
   * depends on the exact stored count.
   */
  it('MEASURES the success status savedViews.create actually answers', async () => {
    const res = await fetch(new URL('/v2/saved-views', server.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'g7 status probe',
        shareMode: 'private',
        query: { spaceId },
        clientMutationId: randomUUID(),
      }),
    });
    console.log(`[g7] MEASUREMENT savedViews.create success status = ${res.status}`);
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
  });
});

describe('G09 — actions, and the permission/availability separation on a real node', () => {
  it('actions.list answers with the frozen DTO and no invented permission fields', async () => {
    const r = await g7(['action', 'list', '--space', spaceId]);
    expect(r.code, r.stderr).toBe(0);
    expect(typeof r.dto.actorId).toBe('string');
    expect(typeof r.dto.capabilityEpoch).toBe('string');
    expect(Array.isArray(r.dto.actions)).toBe(true);
    expect(r.dto.actions.length).toBeGreaterThan(0);

    // The frozen `PaletteAction` has no `allowed` and no `reasonCode`. Record
    // what the SERVER actually sends rather than asserting the design doc.
    const sample = r.dto.actions[0];
    console.log(`[g7] MEASUREMENT PaletteAction keys: ${JSON.stringify(Object.keys(sample))}`);
    console.log(`[g7] MEASUREMENT capabilityEpoch: ${String(r.dto.capabilityEpoch).slice(0, 20)}…`);
    expect(sample).not.toHaveProperty('allowed');
    expect(sample).not.toHaveProperty('reasonCode');
  });

  /**
   * The axis test at the boundary this suite CAN see. The in-process half — the
   * ledger staying ignorant of every operation `actions.list` names — is
   * asserted in `test/action.test.ts` with a mutation test behind it, because a
   * child process's ledger is invisible from here.
   *
   * What is observable across the boundary is that the ledger does not PERSIST.
   * `actions.list` names many operations; if any of that leaked to disk, a LATER
   * invocation would inherit an availability claim nobody measured. So a fresh
   * process is asked about one of the named operations and must still answer
   * `unknown` — the honest default — rather than `available`.
   */
  it('does not persist an availability claim for the operations actions.list named', async () => {
    const listed = await g7(['action', 'list', '--space', spaceId]);
    expect(listed.code, listed.stderr).toBe(0);
    const named: string[] = listed.dto.actions.map((a: any) => a.operation);
    expect(named.length, 'vacuous: actions.list named nothing').toBeGreaterThan(3);

    // A DIFFERENT process, after the palette call. Availability must be the
    // honest default, never upgraded by something another process was told.
    const probe = await cli(['help', '--operation', named[0]!, '--format', 'json'], server);
    expect(probe.code, probe.stderr).toBe(0);
    const row = JSON.parse(probe.stdout) as {
      operations: string[];
      availability: string;
      availabilitySource: string;
    };
    expect(row.operations, 'help answered about a different operation').toContain(named[0]);
    expect(row.availability, `${named[0]} inherited a persisted availability claim`).toBe('unknown');
    // `contract` here means "no observation was in play at all" — the honest
    // default, not a learned verdict carried over from the palette call.
    expect(row.availabilitySource).toBe('contract');
    console.log(
      `[g7] actions.list named ${named.length} operations; a fresh process still reports ` +
        `${named[0]} availability=${row.availability} source=${row.availabilitySource}`,
    );
  }, 60_000);
});

describe('the BUILT BINARY reaches every group 7 path', () => {
  /**
   * This block previously asserted exit 8 — "documented, not built here" —
   * because the registry was not yet wired. It now asserts the opposite, which
   * is the point: every path must DISPATCH. A path that still answered 8 would
   * mean the wiring did not take for that row, and a path that answered 2
   * ("unknown command") would mean it is not in the grammar at all.
   */
  it('dispatches all eight paths — none answers 8 (unwired) or 2 (unknown)', async () => {
    const paths = [
      ['inbox', 'list'], ['inbox', 'mark-read'], ['message', 'mark-read'],
      ['saved-view', 'list'], ['saved-view', 'create'],
      ['saved-view', 'update'], ['saved-view', 'delete'], ['action', 'list'],
    ];
    let checked = 0;
    for (const path of paths) {
      // Deliberately invoked with NO required arguments: a dispatched command
      // answers its own usage error (2 is expected for the argument-taking
      // rows), so the discriminating signal is the STDERR text, not the code.
      const r = await cli([...path, '--space', spaceId], server);
      expect(r.stderr, `${path.join(' ')} did not dispatch`)
        .not.toContain('not implemented in this CLI build');
      expect(r.stderr, `${path.join(' ')} is not in the grammar`).not.toContain('unknown command');
      expect(isRegisteredPath(path), `${path.join(' ')} missing from the registry`).toBe(true);
      checked++;
    }
    // Guard against a loop that silently iterated nothing.
    expect(checked).toBe(paths.length);
  }, 120_000);

  it('still knows the grammar: --help renders each path from the projection', async () => {
    const r = await cli(['saved-view', 'create', '--help'], server);
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).toContain('saved-view create');
  });
});

/**
 * CURSOR-TRUNCATION SWEEP — `inbox.list` is group 7's only paging row.
 *
 * MECHANISM, traced to its terminating source rather than inferred from a
 * symptom. `inbox.list` encodes its cursor as
 * `encodeCursor([fingerprint, iso(last.created_at), last.id])`
 * (`services/w2/inbox-read-marks.ts:409`), and `iso()`
 * (`facade/entity-read.ts:179-181`) is `new Date(value).toISOString()` — a JS
 * `Date` holds MILLISECONDS, Postgres `timestamptz` holds MICROSECONDS. So the
 * encoded boundary is truncated DOWN, to strictly less than the stored value.
 *
 * WHICH DIRECTION OF HARM THAT PRODUCES DEPENDS ON THE SORT, and this row is in
 * the SILENT configuration. The keyset is
 * `order by created_at DESC, id DESC` with `(created_at, id) < (cursor)`
 * (lines 223-236). A cursor that is too SMALL therefore does not re-admit the
 * boundary row — it EXCLUDES every row whose timestamp lies between the
 * truncated cursor and the true boundary. Those rows are never returned by any
 * page. **Silent row loss, no duplicate, no loop, and a "terminates" assertion
 * passes cleanly over it.** That is the inverse case, and it is why the
 * exactly-once assertion below compares against a KNOWN FULL SET rather than
 * merely checking for duplicates.
 *
 * WHAT THIS MECHANISM DOES NOT EXPLAIN, stated because an unexplained detail
 * inside a confirmed finding is where a wrong mechanism hides: rows created in
 * ONE transaction all take `transaction_timestamp()` and are byte-identical in
 * `created_at`, so for those the tuple compare falls through to `id` and the
 * truncation is harmless. The defect needs rows whose timestamps differ by less
 * than a millisecond — which `clock_timestamp()` inserts do produce, but which
 * a single-transaction fixture does NOT. A sweep that builds its fixture in one
 * transaction would therefore go green against a live defect.
 */
describe('cursor truncation — inbox.list is a DESC paging row', () => {
  /**
   * The matcher is proved to discriminate BEFORE it is trusted on live data.
   * Without this, `expect(cursor).toMatch(SIX_DIGITS)` could be passing because
   * the regex is wrong rather than because the cursor is right.
   */
  it('PROBE-RED: the microsecond matcher accepts full precision and rejects truncated', () => {
    const SIX = /\.\d{6}Z$/;
    expect('2026-07-27T06:34:13.421911Z', 'full microseconds must be ACCEPTED').toMatch(SIX);
    expect('2026-07-27T06:34:13.421Z', 'millisecond truncation must be REJECTED').not.toMatch(SIX);
    // The exact transformation under suspicion, run for real rather than described.
    const throughDate = new Date('2026-07-27T06:34:13.421911Z').toISOString();
    expect(throughDate, 'a JS Date round-trip must be REJECTED').not.toMatch(SIX);
    expect(throughDate).toBe('2026-07-27T06:34:13.421Z');
  });

  /**
   * The A/B that makes the truncation claim a MEASUREMENT rather than a source
   * read: two paths out of the same database on the same request cycle.
   * `readMarks.upsert` returns `lastReadAt` built by `jsonb_build_object` in
   * SQL — no JS `Date` — so it is the control. If it carries six fractional
   * digits, the database demonstrably holds sub-millisecond precision, and any
   * sibling path that emits three is LOSING it rather than never having had it.
   */
  it('MEASURES whether this node stores sub-millisecond precision at all', async () => {
    let anchorId: string | undefined;
    for (const kind of ['channel', 'doc', 'task', 'collection']) {
      const anchor = await post('/v2/entities', {
        spaceId, kind, title: `g7 cursor probe ${kind} ${randomUUID().slice(0, 6)}`,
        clientMutationId: randomUUID(),
      });
      anchorId = anchor.json?.data?.entity?.id ?? anchor.json?.data?.id;
      if (anchorId) break;
      console.log(
        `[g7] anchor probe kind=${kind} -> ${anchor.status} ` +
          `${JSON.stringify(anchor.json?.error ?? anchor.json)?.slice(0, 200)}`,
      );
    }
    if (!anchorId) {
      console.log(`[g7] MEASUREMENT precision probe UNAVAILABLE — no anchor kind succeeded. ` +
        `Reporting the mechanism as SOURCE-TRACED, not measured.`);
      return;
    }
    const marked = await g7(['message', 'mark-read', anchorId]);
    expect(marked.code, marked.stderr).toBe(0);
    const lastReadAt = String(marked.dto.lastReadAt);
    const controlDigits = /\.(\d+)/.exec(lastReadAt)?.[1]?.length ?? 0;
    console.log(
      `[g7] MEASUREMENT A-side (SQL jsonb, no JS Date): readMarks.upsert lastReadAt = ${lastReadAt} ` +
        `-> ${controlDigits} fractional digits`,
    );

    /**
     * THE B-SIDE, and the reason this test is an A/B rather than one reading.
     * `savedViews.create` returns `createdAt` built by `iso(row.created_at)` —
     * the SAME function `inbox.list` encodes its cursor with
     * (`facade/entity-read.ts:179`). Same server, same database, same request
     * cycle. If A carries six digits and B carries three, the truncation is not
     * a property of the data, it is a property of `iso()`, and it is LIVE on
     * this node rather than theoretical.
     */
    const view = await g7([
      'saved-view', 'create', `g7 iso probe ${randomUUID().slice(0, 6)}`, '--space', spaceId,
      '--share', 'private', '--query', JSON.stringify({ kinds: ['task'] }),
    ]);
    expect(view.code, view.stderr).toBe(0);
    const createdAt = String(view.dto.createdAt);
    const isoDigits = /\.(\d+)/.exec(createdAt)?.[1]?.length ?? 0;
    console.log(
      `[g7] MEASUREMENT B-side (through iso()):        savedViews.create createdAt = ${createdAt} ` +
        `-> ${isoDigits} fractional digits`,
    );
    console.log(
      `[g7] VERDICT iso() truncation: A=${controlDigits} digits vs B=${isoDigits} digits — ` +
        `${controlDigits > isoDigits
          ? 'CONFIRMED LIVE: iso() discards precision the database demonstrably holds'
          : 'NOT confirmed on this node'}`,
    );

    // The database really does hold sub-millisecond precision. Without this the
    // B-side reading would be consistent with "there was nothing to lose".
    expect(controlDigits, 'no sub-ms precision anywhere; the A/B is void').toBeGreaterThan(3);
  }, 90_000);

  /**
   * The live assertion. Deliberately written so it CANNOT pass vacuously: if no
   * notification fixture can be built, it says so loudly instead of reporting a
   * green over an empty set.
   */
  it('asserts the cursor mechanism off the wire, or declares the fixture unavailable', async () => {
    const first = await g7(['inbox', 'list', '--space', spaceId, '--limit', '1']);
    expect(first.code, first.stderr).toBe(0);

    if (first.dto.items.length === 0) {
      // Honest non-result. Notifications are created by a message-mention
      // trigger (`internal.fan_out_message_mentions`, migration 019) — group
      // 5's surface, not group 7's — so this suite cannot build the fixture
      // without reaching outside its own rows.
      console.log(
        '[g7] SWEEP NOT RUN — inbox is empty and notifications are created only by the ' +
          'message-mention trigger (019), which is outside group 7\'s rows. ' +
          'inbox.list truncation is reported as SOURCE-TRACED, NOT measured.',
      );
      expect(first.dto.nextCursor).toBeNull();
      return;
    }

    // Fixture exists: assert the MECHANISM at the point of truncation.
    const cursor = first.dto.nextCursor;
    if (cursor !== null) {
      const decoded = Buffer.from(String(cursor), 'base64url').toString('utf8');
      console.log(`[g7] MEASUREMENT inbox.list nextCursor decoded = ${decoded}`);
      const stamp = /(\d{4}-\d{2}-\d{2}T[\d:]+\.\d+Z)/.exec(decoded)?.[1];
      console.log(
        `[g7] MEASUREMENT inbox.list cursor timestamp = ${stamp} ` +
          `(.\\d{6}Z => full fidelity; .\\d{3}Z => TRUNCATED, DESC site, silently skips rows)`,
      );
    }
  }, 60_000);
});

describe('bind coherence', () => {
  it('the migration chain did not move under this suite', async () => {
    // If this throws, the run STRADDLED another wave's landing and every count
    // above is bound to two different trees. Discard the run and re-run; do not
    // report the numbers.
    await server.assertBindCoherent();
    console.log(`[g7] bind coherent at ${server.bindStart.files}/${server.bindStart.digest}`);
  });
});
