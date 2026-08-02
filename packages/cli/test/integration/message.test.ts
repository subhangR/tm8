/**
 * GROUP 5 against the REAL Server — message / attachment / delivery / handoff.
 *
 * The coordinator's harness starts the production Server as a CHILD PROCESS on
 * an isolated, freshly-migrated scratch database and talks to it over HTTP,
 * exactly as an agent does. It registers nothing and helps nothing: an operation
 * that is not composed is observed answering its own honest 501.
 *
 * WHAT THIS SUITE MEASURES RATHER THAN ASSUMES:
 *
 *  - per-operation availability for all ten rows this slot owns, resolved from
 *    `unknown` to a real verdict by sending SCHEMA-VALID bodies, which is the
 *    domain work the harness deliberately does not do for anyone;
 *  - whether `messages.list` — a handler that was REPLACED by composition, and
 *    the sharpest drift candidate in the tranche — still orders oldest-first and
 *    still resumes a cursor;
 *  - obligation O1: what `message send --wait settled` actually does on this
 *    node, end to end.
 *
 * TWO EXIT-8s EXIST AND THEY ARE DIFFERENT FACTS. `run.ts` answers 8 for a
 * command that is in the grammar but not wired into THIS CLI BUILD; the Server
 * answers 501 → 8 for an operation not implemented on THIS NODE. They share a
 * code and are told apart only by their stderr. `drive()` below refuses to
 * conflate them, and `commandMode` reports which path every measurement took —
 * an in-process result must never be passed off as built-binary evidence.
 */
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bindPath, decodeCursor } from '@tm8/contract';

import { assertBuilt, cli, startRealServer, type ObservedAvailability, type RealServer } from './harness.js';
import { parseInvocation, splitCommandPath } from '../../src/args.js';
import { loadLocalConfig, resolveContext, sessionContextFromEnv } from '../../src/context.js';
import { errorLines, exitCodeFor } from '../../src/errors.js';
import { createOutput } from '../../src/output.js';
import { uuidv7 } from '../../src/mutation.js';
import type { CommandModule } from '../../src/run.js';
import { MESSAGE_COMMANDS } from '../../src/commands/message.js';
import { HANDOFF_COMMANDS } from '../../src/commands/handoff.js';

let server: RealServer;

/** 'binary' once the coordinator spreads these modules into `registry.ts`. */
let commandMode: 'binary' | 'in-process' = 'binary';

const MODULES: CommandModule[] = [...MESSAGE_COMMANDS, ...HANDOFF_COMMANDS];
const NOT_WIRED = /is in the tm8 grammar but is not implemented in this CLI build/;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** In-process dispatch through the REAL kernel; only the registry lookup differs. */
async function inProcess(argv: readonly string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const streams = {
    stdout: (chunk: string | Uint8Array) => void out.push(String(chunk)),
    stderr: (chunk: string) => void err.push(chunk),
  };
  const saved = process.env.TM8_BASE_URL;
  process.env.TM8_BASE_URL = server.baseUrl;
  let output = createOutput({ format: 'human', streams });
  try {
    const invocation = parseInvocation(argv);
    output = createOutput({
      format: invocation.globals.format,
      color: invocation.globals.color,
      quiet: invocation.globals.quiet,
      streams,
    });
    const registered = new Map(MODULES.map((m) => [m.path.join(' '), m]));
    const match = splitCommandPath(invocation.positionals, (p) => registered.has(p.join(' ')));
    if (!match) throw new Error(`no group-5 command matched: ${invocation.positionals.join(' ')}`);
    const code = await (registered.get(match.path.join(' ')) as CommandModule).run({
      path: match.path,
      args: match.args,
      options: invocation.options,
      passthrough: invocation.passthrough,
      ctx: resolveContext({
        globals: invocation.globals,
        session: sessionContextFromEnv(),
        config: loadLocalConfig(),
      }),
      out: output,
    });
    return { code, stdout: out.join(''), stderr: err.join('') };
  } catch (error) {
    output.error(errorLines(error));
    return { code: exitCodeFor(error), stdout: out.join(''), stderr: err.join('') };
  } finally {
    if (saved === undefined) delete process.env.TM8_BASE_URL;
    else process.env.TM8_BASE_URL = saved;
  }
}

/**
 * Run the BUILT binary. If — and only if — it reports that this build has no
 * handler for the path, fall back to in-process dispatch and RECORD that fact
 * globally, so no measurement in this file can silently claim binary provenance
 * it does not have.
 */
async function drive(argv: readonly string[]): Promise<Run> {
  const binary = await cli(argv, server);
  if (!NOT_WIRED.test(binary.stderr)) return binary;
  commandMode = 'in-process';
  return inProcess(argv);
}

/** Fixture setup speaks raw HTTP: the CLI is what is under test, not the setup. */
async function http(operation: 'spaces.create' | 'entities.create', body: unknown): Promise<{
  status: number;
  json: Record<string, unknown>;
}> {
  const res = await fetch(new URL(bindPath(operation, {}), server.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/**
 * Reach this suite's OWN scratch database, without touching the read-only
 * harness. The name is `tm8_w4_<label>_<pid>_<random>` and the pid is this
 * process, so it is discovered by pattern rather than reconstructed — and the
 * pattern is anchored to `g5_message` so no other slot's database can match.
 */
async function psql(database: string, sql: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const admin = new URL(
    process.env.TM8_W4_ADMIN_DATABASE_URL ??
      process.env.TM8_MIGRATION_DATABASE_URL ??
      `postgres://${process.env.TM8_PG_USER ?? 'tm8'}@127.0.0.1:${process.env.TM8_PG_PORT ?? '5442'}/postgres`,
  );
  if (database) admin.pathname = `/${database}`;
  return await new Promise((resolve) => {
    const child = spawn('psql', ['-w', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A', admin.href, '-c', sql], {
      env: { ...process.env, PGCONNECT_TIMEOUT: '10' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    child.once('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function scratchDatabase(): Promise<string> {
  const r = await psql('', `select datname from pg_database where datname like 'tm8_w4_g5_message_${process.pid}_%'`);
  const name = r.stdout.trim().split('\n').filter(Boolean);
  if (name.length !== 1) {
    throw new Error(`expected exactly one scratch database for pid ${process.pid}, got ${JSON.stringify(name)}`);
  }
  return String(name[0]);
}

/**
 * Either rendering of a `timestamptz`, parsed to the INSTANT it denotes.
 *
 * There are two spellings of one moment in play and they are not interchangeable
 * as text. The cursor carries the UTC form `2026-07-27T07:15:43.619023Z` — the
 * Server's `MICROS` helper, `to_char(… 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`, always
 * six digits. `created_at::text` renders the SAME INSTANT in the psql session's
 * zone and strips trailing zeros: `2026-07-27 12:45:43.619023+05:30`.
 *
 * Deliberately NOT parsed through `Date`: a `Date` holds MILLISECONDS, which is
 * the exact quantity under test here, so routing either side through one would
 * destroy the evidence and then cheerfully confirm the result.
 */
const TIMESTAMPTZ =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2}){0,2})$/;

interface Stamp {
  /** The instant, in whole microseconds since the epoch. */
  readonly micros: bigint;
  /**
   * The three microsecond digits BELOW the millisecond, zero-padded. Postgres
   * TRIMS trailing zeros in text output, so `.619` and `.619000` are one value
   * and must pad to the same answer. `'000'` means the row landed on an exact
   * millisecond and therefore CANNOT witness microsecond fidelity at all.
   */
  readonly subMillisecond: string;
}

function parseStamp(text: string): Stamp {
  const m = TIMESTAMPTZ.exec(text.trim());
  if (!m) throw new Error(`not a timestamptz rendering: ${JSON.stringify(text)}`);
  const g = (i: number): string => m[i] ?? '';
  const frac = g(7).padEnd(6, '0');
  const zone = g(8);
  let micros =
    BigInt(Date.UTC(Number(g(1)), Number(g(2)) - 1, Number(g(3)), Number(g(4)), Number(g(5)), Number(g(6)))) *
      1000n +
    BigInt(frac);
  if (zone !== 'Z') {
    // `+05`, `+05:30` and `+0530` are all Postgres-legal renderings of an offset.
    const z = zone.slice(1).replace(/:/g, '').padEnd(6, '0');
    const offset =
      (BigInt(z.slice(0, 2)) * 3600n + BigInt(z.slice(2, 4)) * 60n + BigInt(z.slice(4, 6))) * 1_000_000n;
    micros += zone.startsWith('-') ? offset : -offset;
  }
  return { micros, subMillisecond: frac.slice(3) };
}

const MY_ROWS = [
  'messages.list', 'messages.post', 'messages.edit', 'messages.delete',
  'messages.attachments.add', 'messages.attachments.remove', 'messages.delivery.get',
  'handoffs.send', 'handoffs.list', 'handoffs.withdraw',
] as const;

let spaceId = '';
let anchorId = '';

beforeAll(async () => {
  await assertBuilt();
  server = await startRealServer('g5-message');

  // `spaces.create` answers `{space, memberId, defaultChannelId}` — the id is
  // one level in, measured from the Server rather than assumed.
  const space = await http('spaces.create', { name: 'g5 message probe', clientMutationId: uuidv7() });
  spaceId = String((space.json.data as { space?: { id?: unknown } } | undefined)?.space?.id ?? '');
  // Fail LOUDLY with the Server's own answer. A fixture that quietly yields an
  // empty id turns every later measurement into a contract-validation error
  // about the fixture, which reads exactly like a defect in the command.
  if (!spaceId) throw new Error(`fixture spaces.create ${space.status}: ${JSON.stringify(space.json)}`);

  const entity = await http('entities.create', {
    clientMutationId: uuidv7(),
    spaceId,
    kind: 'task',
    title: 'g5 anchor',
  });
  // `entities.create` answers 201 with `{entity, activity, patches}`.
  anchorId = String((entity.json.data as { entity?: { id?: unknown } } | undefined)?.entity?.id ?? '');
  if (!anchorId) throw new Error(`fixture entities.create ${entity.status}: ${JSON.stringify(entity.json)}`);
}, 180_000);

afterAll(async () => {
  await server?.stop();
});

describe('the node this suite measured', () => {
  it('reports its mounted and registered counts, and 101 mounted routes', async () => {
    const health = await server.health();
    // eslint-disable-next-line no-console
    console.log(
      `[g5] ${server.baseUrl} operations=${health.operations} registered=${health.implemented} ` +
        `bind ${server.bindStart.files}/${server.bindStart.digest}`,
    );
    expect(health.ok).toBe(true);
    expect(health.operations).toBe(125); // 124 -> 125 (2026-08-02): execution.launch, the one route that serves what a session was TOLD at spawn.
    // `implemented` is `registry.size` — REGISTERED, never "behaviourally
    // implemented". It is reported, never re-labelled.
    expect(health.implemented).toBeGreaterThan(0);
  });

  it('has usable fixtures, so every later measurement is about messages', () => {
    expect(spaceId).toMatch(/[0-9a-f-]{36}/);
    expect(anchorId).toMatch(/[0-9a-f-]{36}/);
  });

  /**
   * The three-state probe. `unknown` means "registered, but the handler never
   * ran" and is NEVER read as available — an empty-body probe cannot tell a live
   * handler from an unconditional stub, because handler lookup precedes schema
   * validation.
   */
  it('measures three-state availability for all ten owned rows', async () => {
    const observed: Record<string, ObservedAvailability> = {};
    for (const row of MY_ROWS) observed[row] = await server.observe(row);
    // eslint-disable-next-line no-console
    console.log(`[g5] observed ${JSON.stringify(observed, null, 0)}`);
    expect(Object.keys(observed)).toHaveLength(MY_ROWS.length); // never a vacuous sweep
    for (const row of MY_ROWS) {
      expect(['available', 'unavailable', 'unknown']).toContain(observed[row]);
    }
  }, 60_000);
});

/**
 * THE INSTRUMENT, PROVED BEFORE IT IS USED.
 *
 * The cursor assertion below rests entirely on `parseStamp`. An instrument that
 * cannot fail turns the test it serves into theatre — the precise defect that
 * reopened this group — so it is not taken on trust. These are pure and need no
 * Server, and they are PERMANENT rather than a one-off probe: they re-prove the
 * discrimination on every run, which a transient probe cannot do.
 */
describe('the timestamp instrument the cursor assertion reasons with', () => {
  const UTC_WIRE = '2026-07-27T07:15:43.619023Z';
  const SESSION_TEXT = '2026-07-27 12:45:43.619023+05:30';

  it('reads two renderings of one instant as ONE instant', () => {
    // The two spellings that made the old byte-comparison fire. Same moment:
    // 07:15:43.619023Z + 05:30 == 12:45:43.619023+05:30, arithmetic not eyeball.
    expect(parseStamp(UTC_WIRE).micros).toBe(parseStamp(SESSION_TEXT).micros);
  });

  /**
   * ⚠ THE POSITIVE CONTROL. A comparison that treats two renderings as equal is
   * only worth having if it still catches the truncation it was built for.
   */
  it('still catches a millisecond truncation — a `Date` round-trip fails here', () => {
    expect(parseStamp('2026-07-27T07:15:43.619Z').micros).not.toBe(parseStamp(SESSION_TEXT).micros);
    // …and by exactly the microseconds a `Date` would have dropped.
    expect(parseStamp(SESSION_TEXT).micros - parseStamp('2026-07-27T07:15:43.619Z').micros).toBe(23n);
  });

  it('pads Postgres-trimmed trailing zeros rather than miscounting them', () => {
    // `::text` renders `.619000` as `.619`; both are the same instant, and both
    // are an EXACT MILLISECOND that cannot witness microsecond fidelity.
    expect(parseStamp('2026-07-27 12:45:43.619+05:30').micros)
      .toBe(parseStamp('2026-07-27T07:15:43.619000Z').micros);
    expect(parseStamp('2026-07-27 12:45:43.619+05:30').subMillisecond).toBe('000');
    expect(parseStamp('2026-07-27T07:15:43.619000Z').subMillisecond).toBe('000');
  });

  /**
   * THE NON-VACUOUSNESS GUARD'S OWN DISCRIMINATION, asserted in both directions.
   * If this predicate could not tell `…619000` from `…619023`, the guard would
   * wave through exactly the degenerate sample it exists to reject.
   */
  it('distinguishes a sub-millisecond row from one on an exact millisecond', () => {
    expect(parseStamp(SESSION_TEXT).subMillisecond).toBe('023');
    expect(parseStamp(UTC_WIRE).subMillisecond).toBe('023');
    expect(parseStamp('2026-07-27T07:15:43.619000Z').subMillisecond).toBe('000');
    expect(parseStamp('2026-07-27T07:15:43Z').subMillisecond).toBe('000');
  });

  it('refuses text it cannot parse instead of silently returning a wrong instant', () => {
    // A parser that answered 0 for unrecognised input would make every
    // comparison below it pass for the wrong reason.
    expect(() => parseStamp('not-a-timestamp')).toThrow(/not a timestamptz/);
    expect(() => parseStamp('')).toThrow(/not a timestamptz/);
  });
});

describe('message send and message list against the real Server', () => {
  let storedMessageId = '';

  it('stores a durable message and returns a batch whose id is the mutation id', async () => {
    const mutationId = uuidv7();
    const r = await drive([
      'message', 'send', '--to', anchorId, 'first durable message',
      '--mutation-id', mutationId, '--format', 'json',
    ]);
    // eslint-disable-next-line no-console
    console.log(`[g5] message send -> ${r.code} (${commandMode})\n${r.stderr}`);
    expect(r.code).toBe(0);
    const dto = JSON.parse(r.stdout) as { messageBatchId?: string; messages?: { id: string }[] };
    // `messageBatchId == clientMutationId` by design — a published correlation
    // identifier, which is exactly why a caller can retry against it.
    expect(dto.messageBatchId).toBe(mutationId);
    expect(dto.messages).toHaveLength(1);
    storedMessageId = String(dto.messages?.[0]?.id);
    expect(storedMessageId).toMatch(/[0-9a-f-]{36}/);
  }, 60_000);

  /**
   * DRIFT WATCH. `messages.list` was already live with a working body and now
   * has a DIFFERENT implementation behind the same name. A count cannot catch a
   * behavioural change, so the two properties its own handler documents are
   * asserted directly: threads read OLDEST-FIRST, and a cursor RESUMES.
   */
  it('reads the thread back oldest-first', async () => {
    for (const body of ['second', 'third']) {
      const r = await drive(['message', 'send', '--to', anchorId, body, '--mutation-id', uuidv7()]);
      expect(r.code).toBe(0);
    }
    const r = await drive(['message', 'list', anchorId, '--format', 'json']);
    expect(r.code).toBe(0);
    const page = JSON.parse(r.stdout) as { items: { id: string; content: { body: string } }[] };
    expect(page.items.map((i) => i.content.body))
      .toEqual(['first durable message', 'second', 'third']);
  }, 60_000);

  /**
   * ⚠ SERVER DEFECT, FOUND HERE AND DELIBERATELY LEFT RED — see the report.
   *
   * `messages.list` re-emits the BOUNDARY ROW: the last item of page N is the
   * first item of page N+1. `handlers/messages.ts` orders by `msg.created_at`
   * and compares the keyset against `msg.created_at`, but ENCODES the cursor
   * from `last.created_at`, which `ENTITY_COLUMNS` selects as `e.created_at` —
   * a different column, written microseconds earlier in the same transaction.
   * The boundary therefore lands strictly before the last row's real sort key
   * and that row is returned a second time.
   *
   * This assertion states the CONTRACT-correct behaviour on purpose. It is NOT
   * softened to match the defect: a test that accepted the duplicate would go
   * green today and fail the day the Server is fixed, which is precisely
   * backwards. `packages/server/**` is forbidden to this wave, so this is
   * reported for arbitration and NOT worked around in the client — a
   * client-side dedupe would hide a server regression from the gate that has
   * to see it.
   */
  it('resumes a cursor rather than repeating the first page', async () => {
    const first = await drive(['message', 'list', anchorId, '--limit', '2', '--format', 'json']);
    expect(first.code).toBe(0);
    const page1 = JSON.parse(first.stdout) as { items: { id: string }[]; nextCursor: string | null };
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();

    const second = await drive([
      'message', 'list', anchorId, '--limit', '2', '--cursor', String(page1.nextCursor), '--format', 'json',
    ]);
    expect(second.code).toBe(0);
    const page2 = JSON.parse(second.stdout) as { items: { id: string }[] };
    expect(page2.items.length).toBeGreaterThan(0);
    const overlap = page2.items.filter((i) => page1.items.some((j) => j.id === i.id));
    // eslint-disable-next-line no-console
    console.log(
      `[g5][cursor] page1=${JSON.stringify(page1.items.map((i) => i.id))} ` +
        `page2=${JSON.stringify(page2.items.map((i) => i.id))} ` +
        `overlap=${JSON.stringify(overlap.map((i) => i.id))} ` +
        `lastOfPage1===firstOfPage2 -> ${page1.items[page1.items.length - 1]?.id === page2.items[0]?.id}`,
    );
    expect(overlap).toHaveLength(0);
  }, 60_000);

  /**
   * The severe corollary of the boundary-duplication defect above, MEASURED
   * rather than argued: at `--limit 1` the page is exactly the boundary row, so
   * if it repeats, the cursor never advances and a caller paging a thread loops
   * forever. Bounded to two requests — a probe for a non-terminating loop must
   * not itself be one.
   */
  it('advances at --limit 1 rather than returning the same row forever', async () => {
    const first = await drive(['message', 'list', anchorId, '--limit', '1', '--format', 'json']);
    const p1 = JSON.parse(first.stdout) as { items: { id: string }[]; nextCursor: string | null };
    expect(p1.items).toHaveLength(1);
    expect(p1.nextCursor).toBeTruthy();

    const second = await drive([
      'message', 'list', anchorId, '--limit', '1', '--cursor', String(p1.nextCursor), '--format', 'json',
    ]);
    const p2 = JSON.parse(second.stdout) as { items: { id: string }[]; nextCursor: string | null };
    // eslint-disable-next-line no-console
    console.log(
      `[g5][cursor] limit=1 p1=${p1.items[0]?.id} p2=${p2.items[0]?.id} ` +
        `advanced=${p1.items[0]?.id !== p2.items[0]?.id}`,
    );
    expect(p2.items[0]?.id).not.toBe(p1.items[0]?.id);
  }, 60_000);

  /**
   * THE MECHANISM, NOT THE SYMPTOM.
   *
   * The cursor defect was never really "pages overlap" — that was the symptom.
   * The cause is a `timestamptz` round-tripped through a JS `Date`, which holds
   * MILLISECONDS while Postgres holds MICROSECONDS. The encoded key comes out
   * strictly SMALLER than the stored value, so the keyset re-admits its own row.
   *
   * So this reads the cursor back OFF THE WIRE, decodes it, and compares it to
   * the stored column — a reintroduced `Date` round-trip fails HERE, at the
   * point of truncation, instead of waiting for a paging symptom downstream.
   *
   * ⚠ WHAT THIS ASSERTS, AND WHY IT IS NO LONGER A STRING COMPARISON.
   *
   * This test previously required the two to be BYTE-IDENTICAL, and that was a
   * microsecond-fidelity check PLUS AN ACCIDENTAL FORMAT LOCK. The cursor
   * renders at UTC via the Server's `MICROS` helper; `created_at::text` renders
   * the same instant in the psql session's zone. `2026-07-27T07:15:43.619023Z`
   * and `2026-07-27 12:45:43.619023+05:30` are ONE MOMENT with IDENTICAL
   * microseconds — so the lock fired, red, on the day all eight cursor sites
   * were consolidated onto one helper, while the property it exists to protect
   * was never in danger. The surplus was a rendering nobody had promised.
   *
   * So the INSTANT is compared, at whole microseconds, and the WIRE value is
   * separately required to carry six fractional digits. That pair is the actual
   * anti-truncation property and it is indifferent to spelling.
   *
   * ⚠ AND THE GUARD, ASSERTED FIRST, WITHOUT WHICH THE REST IS THEATRE.
   *
   * A row landing on an EXACT MILLISECOND is invisible to this test: a
   * truncated cursor compares EQUAL to it, so instant-equality would pass while
   * proving nothing. Trading a flaky check for a silently vacuous one is the
   * worse trade. The sample is therefore CHOSEN rather than assumed — a fresh
   * thread is paged one row deeper per attempt until a row with a genuine
   * sub-millisecond component is found — and the test FAILS if none is, rather
   * than skipping. A fresh anchor because `nextCursor` keys on the LAST item of
   * the page, so attempt `limit` witnesses the `limit`-th row of the thread, and
   * this must not depend on how many messages a sibling test happened to send.
   */
  it('encodes the cursor at full microsecond fidelity, on a row that can witness it', async () => {
    const database = await scratchDatabase();
    const created = await http('entities.create', {
      clientMutationId: uuidv7(), spaceId, kind: 'task', title: 'g5 cursor-fidelity anchor',
    });
    const anchor = String((created.json.data as { entity?: { id?: unknown } } | undefined)?.entity?.id ?? '');
    expect(anchor).toMatch(/[0-9a-f-]{36}/);

    for (const body of ['c1', 'c2', 'c3', 'c4']) {
      const sent = await drive(['message', 'send', '--to', anchor, body, '--mutation-id', uuidv7()]);
      expect(sent.code).toBe(0);
    }

    const samples: string[] = [];
    let witness: { wire: string; stored: string } | null = null;
    for (let limit = 1; limit <= 3 && !witness; limit++) {
      const r = await drive(['message', 'list', anchor, '--limit', String(limit), '--format', 'json']);
      expect(r.code).toBe(0);
      const page = JSON.parse(r.stdout) as { items: { id: string }[]; nextCursor: string | null };
      expect(page.nextCursor).toBeTruthy();

      const wire = String(decodeCursor(String(page.nextCursor)).k[1]);
      // The cursor keys on the LAST row of the page — read back THAT row.
      const rowId = String(page.items[page.items.length - 1]?.id);
      const stored = (await psql(
        database,
        `select created_at::text from public.messages where entity_id = '${rowId}'`,
      )).stdout.trim();
      samples.push(`limit=${limit} sub-ms=${parseStamp(stored).subMillisecond} wire=${wire} stored=${stored}`);
      if (parseStamp(stored).subMillisecond !== '000') witness = { wire, stored };
    }
    // eslint-disable-next-line no-console
    console.log(`[g5][cursor] microsecond-fidelity samples:\n  ${samples.join('\n  ')}`);

    // GUARD FIRST: without a sub-millisecond component nothing below can fail.
    expect(
      witness,
      `no sampled row carried a sub-millisecond component, so microsecond fidelity is ` +
        `UNOBSERVABLE and a truncated cursor would pass: ${samples.join(' | ')}`,
    ).not.toBeNull();
    const { wire, stored } = witness as NonNullable<typeof witness>;
    expect(parseStamp(stored).subMillisecond).not.toBe('000');

    // ANTI-TRUNCATION: the wire value carries six fractional digits. Safe as a
    // digit COUNT only on this side — `MICROS` pads (`.US`), unlike `::text`.
    expect(wire).toMatch(/\.\d{6}Z$/);

    // THE PROPERTY ITSELF: one instant, to the microsecond, across two spellings.
    expect(parseStamp(wire).micros).toBe(parseStamp(stored).micros);
  }, 180_000);

  /**
   * THE INVERSE HALF, WHICH A "NO OVERLAP" TEST IS BLIND TO.
   *
   * Rounding a cursor DOWN re-admits the boundary row: duplicates and loops,
   * loud. Rounding it UP SKIPS rows: silent data loss, no error, no loop — and
   * a suite that only asserts "terminates and does not overlap" passes cleanly
   * while messages are being dropped.
   *
   * The only assertion that catches both is EXACTLY-ONCE over a KNOWN FULL SET:
   * page a fresh anchor at `--limit 1` and require the union to equal the
   * complete set, in order. The guard bound makes a non-terminating cursor fail
   * as a failed assertion rather than as a hung suite.
   */
  it('pages exactly once over a known full set at --limit 1, and terminates', async () => {
    const created = await http('entities.create', {
      clientMutationId: uuidv7(),
      spaceId,
      kind: 'task',
      title: 'g5 paging anchor',
    });
    const pagingAnchor = String(
      (created.json.data as { entity?: { id?: unknown } } | undefined)?.entity?.id ?? '',
    );
    expect(pagingAnchor).toMatch(/[0-9a-f-]{36}/);

    const expected: string[] = [];
    for (const body of ['p1', 'p2', 'p3', 'p4', 'p5']) {
      const sent = await drive([
        'message', 'send', '--to', pagingAnchor, body, '--mutation-id', uuidv7(), '--format', 'json',
      ]);
      expect(sent.code).toBe(0);
      expected.push(String((JSON.parse(sent.stdout) as { messages: { id: string }[] }).messages[0]?.id));
    }

    const walked: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (; pages < 20; pages++) {
      const argv = ['message', 'list', pagingAnchor, '--limit', '1', '--format', 'json'];
      if (cursor) argv.push('--cursor', cursor);
      const page = await drive(argv);
      expect(page.code).toBe(0);
      const dto = JSON.parse(page.stdout) as { items: { id: string }[]; nextCursor: string | null };
      walked.push(...dto.items.map((i) => i.id));
      cursor = dto.nextCursor;
      if (!cursor) break;
    }
    // eslint-disable-next-line no-console
    console.log(`[g5][cursor] exactly-once walk: ${pages + 1} pages, ${walked.length} of ${expected.length} rows`);
    expect(cursor).toBeNull();       // terminates
    expect(walked).toEqual(expected); // no duplicate AND no silent drop
  }, 180_000);

  it('rejects a malformed cursor with the contract code, not a crash', async () => {
    const r = await drive(['message', 'list', anchorId, '--cursor', 'not-a-cursor']);
    expect(r.code).toBe(2); // invalid_cursor / invalid_input → §7.6 exit 2
    expect(r.stderr).toMatch(/invalid_cursor|invalid_input/);
  }, 60_000);

  it('reads a real delivery view for a stored message', async () => {
    const r = await drive(['message', 'delivery', storedMessageId, '--format', 'json']);
    expect(r.code).toBe(0);
    const view = JSON.parse(r.stdout) as { message: { id: string }; deliveries: unknown[] };
    expect(view.message.id).toBe(storedMessageId);
    expect(Array.isArray(view.deliveries)).toBe(true);
    // eslint-disable-next-line no-console
    console.log(`[g5] delivery rows for a task-anchored message: ${view.deliveries.length}`);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// OBLIGATION O1
// ---------------------------------------------------------------------------

describe('O1 — `message send --wait settled` and exit 11', () => {
  /**
   * O1, MEASURED END TO END. This single test is the obligation.
   *
   * Exit 11 means "stored, but a requested delivery is non-delivered or did not
   * settle". A delivery is REQUESTED only for a `work_session` anchor, so this
   * measures what this node does for a real send and reports the branch it took
   * rather than predicting one. Never inferred from a count or from anyone's
   * description of the tree.
   */
  it('O1: measures the settled path end to end and reports which outcome the node produced', async () => {
    const mutationId = uuidv7();
    const argv = [
      'message', 'send', '--to', anchorId, 'settled probe',
      '--wait', 'settled', '--timeout', '5', '--mutation-id', mutationId, '--format', 'json',
    ];
    const r = await drive(argv);
    // eslint-disable-next-line no-console
    console.log(
      `[g5][O1] ARGV: node packages/cli/dist/index.js ${argv.join(' ')}\n` +
        `[g5][O1] EXIT=${r.code} MODE=${commandMode}\n[g5][O1] STDERR<<${r.stderr}>>`,
    );

    // Whatever the delivery outcome, persistence must have happened and the
    // stored batch must be on stdout — that is the half of exit 11 that stops a
    // caller resending a message which was never lost.
    const dto = JSON.parse(r.stdout) as { messageBatchId?: string; messages?: { id: string }[] };
    expect(dto.messageBatchId).toBe(mutationId);
    expect(dto.messages?.length).toBe(1);

    if (r.code === 11) {
      expect(r.stderr).toMatch(/STORED/);
      expect(r.stderr).toMatch(/do not resend/);
      return;
    }

    // Exit 0 is only honest here if the node genuinely requested no delivery.
    // Proven, not assumed: read the delivery rows for the message just stored.
    expect(r.code).toBe(0);
    const messageId = String(dto.messages?.[0]?.id);
    const view = await drive(['message', 'delivery', messageId, '--format', 'json']);
    expect(view.code).toBe(0);
    const deliveries = (JSON.parse(view.stdout) as { deliveries: unknown[] }).deliveries;
    expect(deliveries).toHaveLength(0);
  }, 120_000);

  /**
   * The remaining O1 risk that no stub can retire: does the settle loop read the
   * fields the REAL `messages.delivery.get` actually emits?
   *
   * The unit suite proves the exit-11 mapping, but it feeds the loop a delivery
   * view this slot wrote. If the real DTO spelled `status` or
   * `targetWorkSessionId` differently, that unit test would still pass and
   * production would silently exit 0 on an undelivered message — the exact
   * shape of failure O1 exists to prevent. So a real delivery row is written
   * into this suite's own scratch database and read back THROUGH the built
   * binary and the real handler.
   *
   * LABELLED PRECISELY: the row is FIXTURE state. This is not the node
   * naturally producing an unsettled delivery, and it is not O1 discharged.
   */
  it('reads the real delivery DTO with the exact fields the settle loop consumes', async () => {
    const sent = await drive([
      'message', 'send', '--to', anchorId, 'delivery dto probe', '--mutation-id', uuidv7(), '--format', 'json',
    ]);
    expect(sent.code).toBe(0);
    const messageId = String((JSON.parse(sent.stdout) as { messages: { id: string }[] }).messages[0]?.id);

    const database = await scratchDatabase();
    const workSessionId = uuidv7();
    const inserted = await psql(
      database,
      `insert into public.entities(id, space_id, kind, visibility, created_by)
         select '${workSessionId}', space_id, 'work_session', visibility, created_by
           from public.entities where id = '${anchorId}';
       insert into public.work_sessions(entity_id) values ('${workSessionId}');
       insert into public.session_message_deliveries
         (delivery_id, message_id, target_work_session_id, status, settled_at)
       values ('${uuidv7()}', '${messageId}', '${workSessionId}', 'failed_permanent', now());`,
    );
    // eslint-disable-next-line no-console
    console.log(`[g5][O1] fixture delivery row insert -> ${inserted.code} ${inserted.stderr.trim()}`);
    expect(inserted.code).toBe(0);

    const view = await drive(['message', 'delivery', messageId, '--format', 'json']);
    expect(view.code).toBe(0);
    const dto = JSON.parse(view.stdout) as {
      deliveries: { status?: string; targetWorkSessionId?: string; settledAt?: string | null }[];
    };
    // eslint-disable-next-line no-console
    console.log(`[g5][O1] real delivery DTO -> ${JSON.stringify(dto.deliveries)}`);
    expect(dto.deliveries).toHaveLength(1);
    // The fields `waitForSettlement` reads, confirmed against the real wire.
    expect(dto.deliveries[0]?.status).toBe('failed_permanent');
    expect(dto.deliveries[0]?.targetWorkSessionId).toBe(workSessionId);

    /**
     * ⚠ `settledAt` IS NOW LOAD-BEARING, so it is verified here rather than
     * assumed. The settle loop decides settlement on this field instead of on a
     * status allowlist — the allowlist got `failed_retryable` wrong, because the
     * CHECK constraint settles it and the NAME suggests otherwise. Keying on the
     * stamp is only sound if the real Server actually sends the stamp: if it
     * arrived `null` or absent on a genuinely settled row, every `--wait
     * settled` would poll to the budget and then report a timeout that never
     * happened. A unit double cannot prove this half — it would just be this
     * slot asserting its own fixture back at itself.
     */
    expect(typeof dto.deliveries[0]?.settledAt).toBe('string');
    expect(parseStamp(String(dto.deliveries[0]?.settledAt)).micros).toBeGreaterThan(0n);
  }, 120_000);

  /**
   * THE `failed_retryable` HALF, against the REAL handler.
   *
   * `session_message_deliveries_state_shape` (`015_w1_foundations.sql`) places
   * `failed_retryable` in the `settled_at IS NOT NULL` partition — it is settled
   * FOR THAT ROW, and a retry is a new `delivery_id` with `attempt_no + 1`. The
   * settle loop used to exclude it from its terminal set and poll it to the
   * timeout.
   *
   * LABELLED PRECISELY, because the distinction is the whole point: the row is
   * FIXTURE state, and this does NOT drive the settle loop against a naturally
   * produced retryable delivery — delivery reservation is unwired on this node,
   * measured by the O1-trigger test above, so no CLI-reachable path can mint
   * one. What it does prove, on the real wire, is the premise the fix rests on:
   * a `failed_retryable` row comes back with `settledAt` STAMPED, so the loop
   * will see it as settled the first time it looks.
   */
  it('a real failed_retryable delivery arrives SETTLED on the wire, stamp and all', async () => {
    const sent = await drive([
      'message', 'send', '--to', anchorId, 'retryable settlement probe', '--mutation-id', uuidv7(), '--format', 'json',
    ]);
    expect(sent.code).toBe(0);
    const messageId = String((JSON.parse(sent.stdout) as { messages: { id: string }[] }).messages[0]?.id);

    const database = await scratchDatabase();
    const workSessionId = uuidv7();
    const inserted = await psql(
      database,
      `insert into public.entities(id, space_id, kind, visibility, created_by)
         select '${workSessionId}', space_id, 'work_session', visibility, created_by
           from public.entities where id = '${anchorId}';
       insert into public.work_sessions(entity_id) values ('${workSessionId}');
       insert into public.session_message_deliveries
         (delivery_id, message_id, target_work_session_id, status, settled_at)
       values ('${uuidv7()}', '${messageId}', '${workSessionId}', 'failed_retryable', now());`,
    );
    // The CHECK constraint is the authority: if it REFUSED this row, the claim
    // that `failed_retryable` stamps `settled_at` would be false and the fix
    // built on it would be wrong. The insert succeeding is itself the evidence.
    // eslint-disable-next-line no-console
    console.log(`[g5][settle] failed_retryable + settled_at insert -> ${inserted.code} ${inserted.stderr.trim()}`);
    expect(inserted.code).toBe(0);

    const view = await drive(['message', 'delivery', messageId, '--format', 'json']);
    expect(view.code).toBe(0);
    const dto = JSON.parse(view.stdout) as {
      deliveries: { status?: string; settledAt?: string | null }[];
    };
    // eslint-disable-next-line no-console
    console.log(`[g5][settle] real failed_retryable DTO -> ${JSON.stringify(dto.deliveries)}`);
    expect(dto.deliveries).toHaveLength(1);
    expect(dto.deliveries[0]?.status).toBe('failed_retryable');
    // SETTLED, despite the name. This is the fact the old allowlist denied.
    expect(typeof dto.deliveries[0]?.settledAt).toBe('string');
    expect(parseStamp(String(dto.deliveries[0]?.settledAt)).micros).toBeGreaterThan(0n);
  }, 120_000);

  /**
   * THE O1 TRIGGER ITSELF, MEASURED.
   *
   * Exit 11 requires a REQUESTED delivery, and a delivery is requested only for
   * a `work_session` anchor. So this builds the one anchor kind that can trigger
   * it — as fixture state, since `entities.create` refuses the kind — sends to
   * it through the BUILT BINARY with `--wait settled`, and then asks the
   * database directly whether the node reserved anything.
   *
   * The test asserts whichever branch the node actually produces. It does not
   * predict one, and it is written so that the day delivery reservation is wired
   * the exit-11 branch starts being taken WITHOUT this test being edited.
   */
  it('O1 trigger: measures whether a work_session anchor reserves a live delivery here', async () => {
    const database = await scratchDatabase();
    const workSessionId = uuidv7();
    const made = await psql(
      database,
      `insert into public.entities(id, space_id, kind, visibility, created_by)
         select '${workSessionId}', space_id, 'work_session', visibility, created_by
           from public.entities where id = '${anchorId}';
       insert into public.work_sessions(entity_id, status) values ('${workSessionId}', 'running');`,
    );
    expect(made.code).toBe(0);

    const mutationId = uuidv7();
    const r = await drive([
      'message', 'send', '--to', workSessionId, 'wake probe',
      '--wait', 'settled', '--timeout', '5', '--mutation-id', mutationId, '--format', 'json',
    ]);
    // eslint-disable-next-line no-console
    console.log(`[g5][O1-trigger] exit=${r.code} mode=${commandMode}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);

    if (r.code === 11) {
      // O1 satisfied naturally: stored, and a requested delivery did not deliver.
      expect(r.stderr).toMatch(/STORED/);
      expect(r.stderr).toMatch(/do not resend/);
      return;
    }

    expect(r.code).toBe(0);
    const messageId = String(
      (JSON.parse(r.stdout) as { messages: { id: string }[] }).messages[0]?.id,
    );
    const rows = await psql(
      database,
      `select status from public.session_message_deliveries where message_id = '${messageId}'`,
    );
    // eslint-disable-next-line no-console
    console.log(`[g5][O1-trigger] reserved delivery rows: ${JSON.stringify(rows.stdout.trim())}`);
    // Exit 0 is honest ONLY if the node genuinely reserved nothing to settle.
    expect(rows.stdout.trim()).toBe('');
  }, 120_000);

  /**
   * WHY the unsettled state is unreachable here, measured rather than read off
   * the source. A delivery intent is emitted only for a `work_session` anchor,
   * and `entities.create` cannot make one — so no CLI-reachable path on this
   * node can request a live delivery.
   */
  it('measures that no work_session anchor can be created through the public surface', async () => {
    const r = await http('entities.create', {
      clientMutationId: uuidv7(),
      spaceId,
      kind: 'work_session',
      title: 'g5 would-be session',
    });
    // eslint-disable-next-line no-console
    console.log(`[g5][O1] entities.create kind=work_session -> ${r.status} ${JSON.stringify(r.json)}`);
    expect(r.status).toBeGreaterThanOrEqual(400);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// The rest of the owned surface, against the real Server.
// ---------------------------------------------------------------------------

describe('the remaining owned rows answer for real', () => {
  it('edits and then redacts a message under a version guard', async () => {
    const sent = await drive([
      'message', 'send', '--to', anchorId, 'to be edited', '--mutation-id', uuidv7(), '--format', 'json',
    ]);
    expect(sent.code).toBe(0);
    const id = String((JSON.parse(sent.stdout) as { messages: { id: string }[] }).messages[0]?.id);

    const stale = await drive([
      'message', 'update', id, 'edited body', '--expect-version', '99', '--mutation-id', uuidv7(),
    ]);
    // A guard that does not match is a version conflict — §7.6 exit 6 — and
    // never a silent overwrite.
    expect([5, 6]).toContain(stale.code);

    const read = await drive(['message', 'list', anchorId, '--format', 'json']);
    const item = (JSON.parse(read.stdout) as { items: { id: string; version?: number }[] })
      .items.find((i) => i.id === id);
    const version = Number(item?.version ?? 1);

    const edited = await drive([
      'message', 'update', id, 'edited body', '--expect-version', String(version), '--mutation-id', uuidv7(),
    ]);
    // eslint-disable-next-line no-console
    console.log(`[g5] message update -> ${edited.code}\n${edited.stderr}`);
    expect([0, 5, 6]).toContain(edited.code);
  }, 120_000);

  it('handoff list answers for a real work-session id shape', async () => {
    const r = await drive(['handoff', 'list', anchorId, '--format', 'json']);
    // eslint-disable-next-line no-console
    console.log(`[g5] handoff list -> ${r.code}\n${r.stderr}`);
    // Any answer is acceptable evidence EXCEPT a crash or a fabricated success:
    // 0 (empty page), 4/5 (the anchor is not a work session) are all honest.
    expect([0, 4, 5, 6]).toContain(r.code);
  }, 60_000);

  it('handoff send refuses --expect-source-version locally and never reaches the wire', async () => {
    const r = await drive([
      'handoff', 'send', anchorId, '--entity', anchorId, '--expect-source-version', '1',
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/SendHandoffInput/);
  }, 60_000);
});

/**
 * COVERAGE CLOSURE. W4 is the terminal wave, so a row never exercised against a
 * real Server is never exercised at all. These tests exist to turn UNIT-ONLY
 * rows into real-Server observations — and an authoritative REFUSAL counts:
 * knowing exactly what the Server says, with its taxonomy code, is worth more
 * than a bare pass, and it is a fact the CLI is forbidden to fabricate.
 */
describe('coverage closure for the rows that were otherwise unit-only', () => {
  it('messages.delete: redacts a real message under a real version guard', async () => {
    const sent = await drive([
      'message', 'send', '--to', anchorId, 'to be redacted', '--mutation-id', uuidv7(), '--format', 'json',
    ]);
    expect(sent.code).toBe(0);
    const id = String((JSON.parse(sent.stdout) as { messages: { id: string }[] }).messages[0]?.id);

    const listed = await drive(['message', 'list', anchorId, '--format', 'json']);
    const row = (JSON.parse(listed.stdout) as { items: { id: string; version?: number }[] })
      .items.find((i) => i.id === id);
    const version = Number(row?.version ?? 1);

    const deleted = await drive([
      'message', 'delete', id, '--expect-version', String(version), '--yes', '--mutation-id', uuidv7(),
    ]);
    // eslint-disable-next-line no-console
    console.log(`[g5][coverage] message delete -> ${deleted.code}\nstdout:${deleted.stdout}\nstderr:${deleted.stderr}`);
    expect([0, 5, 6]).toContain(deleted.code);
    if (deleted.code !== 0) return;

    // O5 against the REAL Server: the row must survive in the thread.
    const after = await drive(['message', 'list', anchorId, '--format', 'json']);
    const still = (JSON.parse(after.stdout) as { items: { id: string }[] }).items.some((i) => i.id === id);
    // eslint-disable-next-line no-console
    console.log(`[g5][coverage] redacted row still present in thread: ${still}`);
    expect(still).toBe(true);
  }, 120_000);

  /**
   * THE OPTIONAL-FIELD SWEEP, ON THE ONE ROW OF MINE THAT HAS THE SHAPE.
   *
   * `PatchMessageInputSchema.mentions` is OPTIONAL and the CLI has no flag that
   * can fill it (`--mention` is refused on update, because the frozen DTO wants
   * full `Mention` objects and this CLI holds only ids). The service then does
   * `(input.mentions ?? []).map(...)` and hands the RPC an EMPTY ARRAY — so if
   * the RPC assigns that array wholesale, editing a message silently CLEARS its
   * mentions at exit 0.
   *
   * That is the exact class: an optional field a caller cannot express, nulled
   * by a wholesale-replacement write, failing silently. So it is MEASURED here,
   * with a POSITIVE CONTROL first — if the mention never stored, a clean "no
   * mentions after" would prove nothing at all.
   */
  it('SWEEP: does an edit that cannot express mentions destroy stored mentions?', async () => {
    const database = await scratchDatabase();
    const member = await psql(
      database,
      `select entity_id from public.members where identity_id is not null limit 1`,
    );
    const mentionId = member.stdout.trim();
    expect(mentionId).toMatch(/[0-9a-f-]{36}/);

    const sent = await drive([
      'message', 'send', '--to', anchorId, 'mentions @owner', '--mention', mentionId,
      '--mutation-id', uuidv7(), '--format', 'json',
    ]);
    expect(sent.code).toBe(0);
    const id = String((JSON.parse(sent.stdout) as { messages: { id: string }[] }).messages[0]?.id);

    // POSITIVE CONTROL — read the stored column directly. Without this, an
    // empty "after" is indistinguishable from a mention that never stored.
    const before = await psql(database, `select mentions from public.messages where entity_id = '${id}'`);
    // eslint-disable-next-line no-console
    console.log(`[g5][sweep] mentions BEFORE edit: ${before.stdout.trim()}`);
    if (before.stdout.trim() === '' || before.stdout.trim() === '[]') {
      // eslint-disable-next-line no-console
      console.log('[g5][sweep] INCONCLUSIVE — nothing was stored to lose; not reported as a finding');
      return;
    }

    const listed = await drive(['message', 'list', anchorId, '--format', 'json']);
    const version = Number(
      (JSON.parse(listed.stdout) as { items: { id: string; version?: number }[] })
        .items.find((i) => i.id === id)?.version ?? 1,
    );
    const edited = await drive([
      'message', 'update', id, 'edited, mentions not expressible', '--expect-version', String(version),
      '--mutation-id', uuidv7(),
    ]);
    // eslint-disable-next-line no-console
    console.log(`[g5][sweep] message update -> ${edited.code} ${edited.stderr.trim()}`);
    if (edited.code !== 0) return;

    const after = await psql(database, `select mentions from public.messages where entity_id = '${id}'`);
    // eslint-disable-next-line no-console
    console.log(`[g5][sweep] mentions AFTER edit: ${JSON.stringify(after.stdout.trim())}`);
    // Asserts the CONTRACT-correct outcome: an edit that cannot mention anything
    // must not destroy what is stored. If this is red, it is a server-owned
    // silent-data-loss finding, reported and NOT compensated for in the client.
    expect(after.stdout.trim()).toBe(before.stdout.trim());
  }, 120_000);

  it('messages.attachments.add: records what the Server says about a non-finalized file', async () => {
    const sent = await drive([
      'message', 'send', '--to', anchorId, 'attachment probe', '--mutation-id', uuidv7(), '--format', 'json',
    ]);
    expect(sent.code).toBe(0);
    const id = String((JSON.parse(sent.stdout) as { messages: { id: string }[] }).messages[0]?.id);

    const file = await http('entities.create', {
      clientMutationId: uuidv7(), spaceId, kind: 'file', title: 'g5 attachment',
    });
    const fileId = String((file.json.data as { entity?: { id?: unknown } } | undefined)?.entity?.id ?? '');
    expect(fileId).toMatch(/[0-9a-f-]{36}/);

    const added = await drive([
      'message', 'attachment', 'add', id, fileId, '--expect-version', '1', '--mutation-id', uuidv7(),
    ]);
    // eslint-disable-next-line no-console
    console.log(`[g5][coverage] message attachment add -> ${added.code}\nstderr:${added.stderr}`);
    // Whatever the verdict, it must be a contract-shaped answer, never a crash.
    expect([0, 2, 4, 5, 6, 9]).toContain(added.code);

    const removed = await drive([
      'message', 'attachment', 'remove', id, fileId, '--expect-version', '1', '--mutation-id', uuidv7(),
    ]);
    // eslint-disable-next-line no-console
    console.log(`[g5][coverage] message attachment remove -> ${removed.code}\nstderr:${removed.stderr}`);
    expect([0, 2, 4, 5, 6]).toContain(removed.code);
  }, 120_000);

  it('handoffs.send/withdraw: exercised against a real work session', async () => {
    const database = await scratchDatabase();
    const workSessionId = uuidv7();
    const made = await psql(
      database,
      `insert into public.entities(id, space_id, kind, visibility, created_by)
         select '${workSessionId}', space_id, 'work_session', visibility, created_by
           from public.entities where id = '${anchorId}';
       insert into public.work_sessions(entity_id, status) values ('${workSessionId}', 'running');`,
    );
    expect(made.code).toBe(0);

    const handoffId = uuidv7();
    const sent = await drive([
      'handoff', 'send', workSessionId, '--entity', anchorId,
      '--mutation-id', handoffId, '--format', 'json',
    ]);
    // eslint-disable-next-line no-console
    console.log(`[g5][coverage] handoff send -> ${sent.code}\nstdout:${sent.stdout}\nstderr:${sent.stderr}`);
    expect([0, 2, 4, 5, 6]).toContain(sent.code);

    const listed = await drive(['handoff', 'list', workSessionId, '--limit', '1', '--format', 'json']);
    expect(listed.code).toBe(0);
    const page = JSON.parse(listed.stdout) as { items: unknown[]; nextCursor: string | null };
    // eslint-disable-next-line no-console
    console.log(`[g5][coverage] handoff list items=${page.items.length} nextCursor=${page.nextCursor ? 'yes' : 'null'}`);

    /**
     * PRIMARY paging assertion for this row, compared as an INSTANT.
     *
     * This block used to re-render the stored value with a COPY of the
     * production `to_char` format string and require byte-equality. That is the
     * same format lock that reopened this group, in its purest form: the test
     * pinned the Server's SPELLING rather than its PRECISION, and it pinned it
     * by duplicating the very format string whose eight-way duplication caused
     * the problem. `::text` is deliberately a DIFFERENT rendering — comparing
     * across two renderings is what makes the check about the instant.
     *
     * Conditional, and therefore LOGGED WHEN IT DOES NOT RUN: an assertion
     * inside `if (nextCursor)` that silently never executes is a vacuous pass,
     * and a skipped check must never read like a passed one.
     */
    if (page.nextCursor) {
      const key = String(decodeCursor(String(page.nextCursor)).k[1]);
      const stored = (await psql(
        database,
        `select created_at::text from public.session_handoffs order by created_at asc limit 1`,
      )).stdout.trim();
      // eslint-disable-next-line no-console
      console.log(`[g5][cursor] handoffs.list wire=${JSON.stringify(key)} stored=${JSON.stringify(stored)}`);
      expect(key).toMatch(/\.\d{6}Z$/);
      expect(parseStamp(key).micros).toBe(parseStamp(stored).micros);
    } else {
      // eslint-disable-next-line no-console
      console.log('[g5][cursor] handoffs.list NOT ASSERTED here — no cursor was issued for this page');
    }

    /**
     * `handoffs.send` is REFUSED for this actor on this node (see the logged
     * exit code above), so the guard below cannot depend on it having worked.
     * The handoff row is seeded directly instead — LABELLED FIXTURE STATE — so
     * that `handoffs.withdraw`'s guard is exercised against a real row through
     * the real handler, which is the claim under test. Two rows, so that
     * `handoff list --limit 1` yields a cursor to check.
     */
    const snapshot = JSON.stringify({
      entityId: anchorId, kind: 'task', title: 'g5 anchor', contentVersion: 1,
      sourceSpaceId: spaceId, body: '', bodyBytes: 0, truncated: false, omittedFields: [],
    });
    const seedIds = [handoffId, uuidv7()];
    for (const [n, id] of seedIds.entries()) {
      const seeded = await psql(
        database,
        `insert into public.session_handoffs
           (handoff_id, source_entity_id, target_work_session_id, delivery_status, record_status,
            request_hash, source_snapshot, envelope_hash, record_version,
            identity_id, request_id, author_id, source_space_id, resolved_content_version)
         select '${id}', '${anchorId}', '${workSessionId}', 'delivered', 'recorded',
                'g5-request-hash-${n}', '${snapshot}'::jsonb, 'g5-envelope-hash-${n}', 1,
                mem.identity_id, 'g5-seed-${n}', mem.entity_id, '${spaceId}', 1
           from public.members mem where mem.identity_id is not null limit 1
         on conflict (handoff_id) do nothing;`,
      );
      // eslint-disable-next-line no-console
      if (seeded.code !== 0) console.log(`[g5][guard] seed failed: ${seeded.stderr.trim()}`);
      expect(seeded.code).toBe(0);
    }

    const paged = await drive(['handoff', 'list', workSessionId, '--limit', '1', '--format', 'json']);
    // eslint-disable-next-line no-console
    console.log(`[g5][coverage] handoff list (seeded) -> ${paged.code} ${paged.stdout.slice(0, 200)}`);
    if (paged.code === 0) {
      const p = JSON.parse(paged.stdout) as { items: unknown[]; nextCursor: string | null };
      // Same instant comparison as above, on the seeded two-row page.
      if (p.nextCursor) {
        const key = String(decodeCursor(String(p.nextCursor)).k[1]);
        const stored = (await psql(
          database,
          `select created_at::text from public.session_handoffs
             order by created_at asc, handoff_id asc limit 1`,
        )).stdout.trim();
        // eslint-disable-next-line no-console
        console.log(`[g5][cursor] handoffs.list (seeded) wire=${JSON.stringify(key)} stored=${JSON.stringify(stored)}`);
        expect(key).toMatch(/\.\d{6}Z$/);
        expect(parseStamp(key).micros).toBe(parseStamp(stored).micros);
      } else {
        // eslint-disable-next-line no-console
        console.log('[g5][cursor] handoffs.list (seeded) NOT ASSERTED — no cursor was issued for this page');
      }
    }

    /**
     * THE GUARD FLAG, PROVED ENFORCED RATHER THAN MERELY ACCEPTED.
     *
     * A `.strict()` schema accepting `expectedRecordVersion` proves only that
     * the field is TOLERATED. A handler could parse it and never compare it, and
     * a parsed-but-ignored guard is IDENTICAL to a working one on every
     * happy-path test. The refusal call is the one that separates them.
     */
    const versionOf = async (): Promise<string> =>
      (await psql(database, `select record_version from public.session_handoffs where handoff_id = '${handoffId}'`))
        .stdout.trim();

    const before = await versionOf();
    // eslint-disable-next-line no-console
    console.log(`[g5][guard] handoffs.withdraw record_version before = ${JSON.stringify(before)}`);
    expect(before).not.toBe('');

    // OMISSION — required-ness is real, not decorative.
    const omitted = await drive(['handoff', 'withdraw', handoffId, '--yes', '--mutation-id', uuidv7()]);
    // eslint-disable-next-line no-console
    console.log(`[g5][guard] OMISSION -> ${omitted.code} ${omitted.stderr.trim()}`);
    expect(omitted.code).toBe(2);

    // ACCEPTANCE — the correct current version is taken.
    const accepted = await drive([
      'handoff', 'withdraw', handoffId, '--yes', '--expect-record-version', before,
      '--reason', 'guard acceptance', '--mutation-id', uuidv7(),
    ]);
    // eslint-disable-next-line no-console
    console.log(`[g5][guard] ACCEPTANCE @${before} -> ${accepted.code}\nstderr:${accepted.stderr}`);
    expect(accepted.code).toBe(0);

    // POSITIVE CONTROL — the mutation must actually have MOVED the version, or
    // the replay below is not stale and would pass for the wrong reason.
    const after = await versionOf();
    // eslint-disable-next-line no-console
    console.log(`[g5][guard] record_version after = ${JSON.stringify(after)}`);
    expect(after).not.toBe(before);

    // REFUSAL — replaying the now-stale version must be refused as a conflict.
    const stale = await drive([
      'handoff', 'withdraw', handoffId, '--yes', '--expect-record-version', before,
      '--reason', 'stale replay', '--mutation-id', uuidv7(),
    ]);
    // eslint-disable-next-line no-console
    console.log(`[g5][guard] STALE REPLAY @${before} -> ${stale.code}\nstderr:${stale.stderr}`);
    expect(stale.code).toBe(6); // §7.6: version conflict / invariant violation
  }, 180_000);
});

describe('the bind this suite is reported against', () => {
  /**
   * Called LAST, before any number here is reported. A scratch database is built
   * from whatever is on disk when it is created, so a suite that straddles a
   * migration landing produces a count bound to two trees — meaningless, and it
   * reads exactly like a good result.
   *
   * A throw is expected ONLY inside a landing window the coordinator has
   * announced. Outside one it is a real anomaly and is reported as a finding,
   * not absorbed as noise.
   */
  it('is coherent: the migration chain did not move under this run', async () => {
    await server.assertBindCoherent();
    // eslint-disable-next-line no-console
    console.log(
      `[g5] bind coherent ${server.bindStart.files}/${server.bindStart.digest} · commandMode=${commandMode}`,
    );
  });
});
