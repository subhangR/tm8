/**
 * Error receipts (`tm8.receipt.v1`, `ok:false`; spec doc 01a0cf2e §4.3,
 * §9.4–9.8) against a REAL Server, through the BUILT binary.
 *
 * A counting proxy sits between the CLI and the Server for the cases that
 * need the wire itself: it counts the failure-path read (§9.5 "exactly one
 * extra read"), and it LOSES an answer after forwarding the request (§9.8) —
 * the honest ambiguous outcome, where the write landed and the caller cannot
 * know it. Replaying the receipt's `next` must then create no duplicate.
 *
 * Every error receipt is asserted ≤ 1 KB, and the last test prints the byte
 * size per case for the PR.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { assertBuilt, cli, startRealServer, type RealServer } from './harness.js';

let server: RealServer;
let spaceId = '';
let memberId = '';
let parentId = '';
let sessionId = '';

type Json = Record<string, unknown>;
const ERROR_BUDGET = 1024;
const sizes: string[] = [];

const agent = (extra: Record<string, string> = {}): Record<string, string> => ({
  TM8_JOURNAL_CLASS: 'agent',
  TM8_TEAM_MEMBER_ID: memberId || 'receipt-suite',
  ...extra,
});

// ── the counting / answer-losing proxy ─────────────────────────────────────

let proxy: Server;
let proxyUrl = '';
let wire: string[] = [];
/** `METHOD /path` prefix whose ANSWER is lost after the Server handled it. */
let loseAnswerOf: string | undefined;

beforeAll(async () => {
  await assertBuilt();
  server = await startRealServer('receipt-errors');
  const res = await fetch(new URL('/v2/spaces', server.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'receipt errors scratch', clientMutationId: randomUUID() }),
  });
  const body = (await res.json()) as { data?: { space?: { id?: string }; memberId?: string } };
  spaceId = body.data?.space?.id ?? '';
  memberId = body.data?.memberId ?? '';
  if (!spaceId || !memberId) throw new Error(`space setup failed: ${JSON.stringify(body)}`);
  parentId = await createFull('task', 'receipt error fixtures parent');

  sessionId = randomUUID();
  const made = await psql(
    `insert into public.entities(id, space_id, kind, visibility, created_by)
       select '${sessionId}', space_id, 'work_session', visibility, created_by
         from public.entities where id = '${parentId}';
     insert into public.work_sessions(entity_id, status) values ('${sessionId}', 'running');`,
  );
  if (made.code !== 0) throw new Error(`work_session fixture failed: ${made.stderr}`);

  proxy = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const line = `${req.method} ${new URL(req.url ?? '/', 'http://x').pathname}`;
        wire.push(line);
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === 'string' && k !== 'host' && k !== 'content-length' && k !== 'connection') headers[k] = v;
        }
        const upstream = await fetch(new URL(req.url ?? '/', server.baseUrl), {
          method: req.method,
          headers,
          ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
        });
        const text = await upstream.text();
        if (loseAnswerOf !== undefined && line.startsWith(loseAnswerOf)) {
          req.socket.destroy(); // the Server wrote it; the caller never hears
          return;
        }
        res.statusCode = upstream.status;
        upstream.headers.forEach((v, k) => {
          if (k !== 'content-length' && k !== 'content-encoding' && k !== 'transfer-encoding') res.setHeader(k, v);
        });
        res.end(text);
      })();
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const addr = proxy.address();
  if (addr === null || typeof addr === 'string') throw new Error('no proxy port');
  proxyUrl = `http://127.0.0.1:${addr.port}`;
}, 240_000);

afterAll(async () => {
  await new Promise<void>((resolve) => (proxy ? proxy.close(() => resolve()) : resolve()));
  await server?.stop();
});

async function psql(sql: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const listed = await psqlOn('', `select datname from pg_database where datname like 'tm8_w4_receipt_errors_${process.pid}_%'`);
  const names = listed.stdout.trim().split('\n').filter(Boolean);
  if (names.length !== 1) throw new Error(`expected one scratch database, got ${JSON.stringify(names)}`);
  return psqlOn(String(names[0]), sql);
}

async function psqlOn(database: string, sql: string): Promise<{ code: number; stdout: string; stderr: string }> {
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

const S = (): string[] => ['--space', spaceId];

async function createFull(kind: string, title: string, extra: string[] = []): Promise<string> {
  const parent = parentId ? ['--parent', parentId] : [];
  const r = await cli(['entity', 'create', kind, title, ...S(), ...parent, ...extra, '--format', 'json', '--full'], server);
  expect(r.code, r.stderr).toBe(0);
  return String((JSON.parse(r.stdout) as { entity: { id: string } }).entity.id);
}

async function versionOf(id: string): Promise<number> {
  const r = await cli(['entity', 'get', id, '--format', 'json', '--full'], server);
  return Number((JSON.parse(r.stdout) as { version: number }).version);
}

/** Split a `next` line back into argv as a POSIX shell would (bare + single quotes). */
function shellSplit(line: string): string[] {
  const out: string[] = [];
  const re = /'((?:[^']|'\\'')*)'|(\S+)/g;
  let cur = '';
  let last = 0;
  for (let m = re.exec(line); m !== null; m = re.exec(line)) {
    if (m.index > last && line.slice(last, m.index).trim() === '' && cur !== '') {
      out.push(cur);
      cur = '';
    }
    cur += m[1] !== undefined ? m[1].replace(/'\\''/g, "'") : m[2]!;
    last = re.lastIndex;
  }
  if (cur !== '') out.push(cur);
  expect(out[0]).toBe('tm8');
  return out.slice(1);
}

/** One minified error line on stdout, ≤ 1 KB; recorded for the size table. */
function errorOf(label: string, r: { code: number; stdout: string; stderr: string }, exit: number): Json {
  expect(r.code, r.stderr).toBe(exit);
  expect(r.stderr.startsWith('tm8: '), r.stderr).toBe(true); // the diagnostic is still there
  expect(r.stdout.endsWith('\n')).toBe(true);
  const line = r.stdout.slice(0, -1);
  expect(line).not.toContain('\n');
  const parsed = JSON.parse(line) as Json;
  expect(JSON.stringify(parsed)).toBe(line);
  expect(parsed).toMatchObject({ schemaVersion: 'tm8.receipt.v1', ok: false });
  const size = Buffer.byteLength(line, 'utf8');
  expect(size, line).toBeLessThanOrEqual(ERROR_BUDGET);
  sizes.push(`| ${label} | ${size} |`);
  return parsed;
}

/** stderr with the per-request ids blanked, so two runs compare. */
const stable = (stderr: string): string => stderr.replace(/req_[A-Za-z0-9_]+/g, 'req_*');

describe('version_conflict (§9.4)', () => {
  it('task complete: current version named; `next` is a retry that succeeds without a read', async () => {
    const id = await createFull('task', 'Error fixture conflict complete');
    const v = await versionOf(id);
    const argv = ['task', 'complete', id, '--expect-version', String(v + 5), '--by', memberId, '--format', 'json'];
    const r = await cli(argv, server, agent());
    const receipt = errorOf('conflict (task complete)', r, 6);
    expect(receipt).toMatchObject({ op: 'task.complete', id, error: { code: 'version_conflict', expectedVersion: v + 5, currentVersion: v } });
    const current = (receipt.error as Json).current as Json;
    expect(current).toMatchObject({ status: 'open', title: 'Error fixture conflict complete' });
    expect(typeof current.updatedAt).toBe('string');

    // stderr and exit are what a --full caller sees (D4.1).
    const full = await cli([...argv, '--full'], server, agent());
    expect(full.code).toBe(6);
    expect(full.stdout).toBe('');
    expect(stable(r.stderr)).toBe(stable(full.stderr));

    const retried = await cli(shellSplit(String(receipt.next)), server, agent());
    expect(retried.code, retried.stderr).toBe(0);
    expect(JSON.parse(retried.stdout)).toMatchObject({ ok: true, op: 'task.complete', status: { to: 'done' } });
  }, 120_000);

  it('entity update: `next` is `tm8 entity context <id>`, never a retry', async () => {
    const id = await createFull('task', 'Error fixture conflict update');
    const v = await versionOf(id);
    const r = await cli(['entity', 'update', id, '--expect-version', String(v + 3), '--title', 'nope', '--format', 'json'], server, agent());
    const receipt = errorOf('conflict (entity update)', r, 6);
    expect(receipt.next).toBe(`tm8 entity context ${id}`);
    expect((receipt.error as Json).currentVersion).toBe(v);
  }, 120_000);

  it('human format stays stderr-only', async () => {
    const id = await createFull('task', 'Error fixture conflict human');
    const v = await versionOf(id);
    const r = await cli(['task', 'complete', id, '--expect-version', String(v + 1), '--by', memberId], server, agent());
    expect(r.code).toBe(6);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('version_conflict');
  }, 120_000);
});

describe('gate failures (§9.5)', () => {
  it('acceptance criteria: incomplete[] and an exact count, with EXACTLY ONE extra read', async () => {
    const criteria = [
      { text: 'Evidence archive verified by an independent re-run', done: false },
      { text: 'already done', done: true },
      { text: `Notebook linked from the parent project doc ${'z'.repeat(90)}`, done: false },
    ];
    const id = await createFull('task', 'Error fixture gate criteria');
    const patched = await cli(['entity', 'update', id, '--expect-version', String(await versionOf(id)), '--content', JSON.stringify({ acceptanceCriteria: criteria }), '--format', 'json', '--full'], server);
    expect(patched.code, patched.stderr).toBe(0);
    const v = await versionOf(id);

    wire = [];
    const r = await cli(['task', 'complete', id, '--expect-version', String(v), '--by', memberId, '--format', 'json'], server, agent({ TM8_BASE_URL: proxyUrl }));
    const receipt = errorOf('gate: acceptance_criteria_incomplete (2 criteria)', r, 6);
    expect(wire).toEqual([`POST /v2/entities/${id}/commands/complete`, `GET /v2/entities/${id}`]);
    const error = receipt.error as Json;
    expect(error).toMatchObject({ code: 'invariant_violation', reason: 'acceptance_criteria_incomplete', incompleteCount: 2, retryable: false });
    const rows = error.incomplete as { index: number; text: string }[];
    expect(rows.map((row) => row.index)).toEqual([0, 2]);
    expect(rows[0]!.text).toBe(criteria[0]!.text);
    expect(Array.from(rows[1]!.text)).toHaveLength(80);
    // Bug 01a0d2f1: `next` is the WRITE that clears the refusal, filled in —
    // the criteria ids the Server minted and the version the read saw.
    expect((rows as unknown as { id: string }[]).map((row) => row.id)).toEqual(['ac_1', 'ac_3']);
    expect(receipt.next).toBe(`tm8 task tick ${id} ac_1 ac_3 --expect-version ${v}`);

    // Run it VERBATIM, then complete at the version its receipt names: the
    // whole tick-and-complete flow with no help call and no `entity get`.
    const tick = await cli([...String(receipt.next).split(' ').slice(1), '--format', 'json'], server, agent());
    expect(tick.code, tick.stderr).toBe(0);
    const ticked = JSON.parse(tick.stdout) as Json;
    expect(ticked).toMatchObject({ ok: true, op: 'task.tick', acceptance: { done: 3, total: 3 }, open: [] });
    const to = (ticked.version as { to: number }).to;
    const done = await cli(['task', 'complete', id, '--expect-version', String(to), '--by', memberId, '--format', 'json'], server, agent());
    expect(done.code, done.stderr).toBe(0);
    const flowChars = [r, tick, done].reduce((n, x) => n + x.stdout.length + x.stderr.length, 0);
    sizes.push(`tick-and-complete flow (refusal -> next -> complete): ${flowChars} chars over 3 tm8 calls, 0 help calls`);

    // --full: the same refusal, no read — and stderr still names the verb.
    const again = await createFull('task', 'Error fixture gate criteria full');
    const repatched = await cli(['entity', 'update', again, '--expect-version', String(await versionOf(again)), '--content', JSON.stringify({ acceptanceCriteria: criteria }), '--format', 'json', '--full'], server);
    expect(repatched.code, repatched.stderr).toBe(0);
    wire = [];
    const full = await cli(['task', 'complete', again, '--expect-version', String(await versionOf(again)), '--by', memberId, '--format', 'json', '--full'], server, agent({ TM8_BASE_URL: proxyUrl }));
    expect(full.code).toBe(6);
    expect(wire).toHaveLength(1);
    expect(full.stderr).toContain(`tick them first: tm8 task tick ${again} <criterion-id>...`);
  }, 120_000);

  it('pr_merged gate: gate_no_tracked_pr, then gate_pr_unmerged_or_ci_red with prs[]', async () => {
    const id = await createFull('task', 'Error fixture gate pr');
    const gated = await cli(['task', 'gate', id, 'pr_merged', '--expect-version', String(await versionOf(id)), '--format', 'json', '--full'], server);
    expect(gated.code, gated.stderr).toBe(0);

    wire = [];
    const none = await cli(['task', 'complete', id, '--expect-version', String(await versionOf(id)), '--by', memberId, '--format', 'json'], server, agent({ TM8_BASE_URL: proxyUrl }));
    const noPr = errorOf('gate: gate_no_tracked_pr', none, 6);
    expect(noPr.error).toMatchObject({ reason: 'gate_no_tracked_pr', prs: [] });
    expect(wire).toHaveLength(1); // the refusal IS the claim that no PR is tracked: no read

    const url = 'https://github.com/example/receipt-errors/pull/42';
    expect((await cli(['task', 'link-pr', id, url, '--format', 'json', '--full'], server)).code).toBe(0);
    wire = [];
    const open = await cli(['task', 'complete', id, '--expect-version', String(await versionOf(id)), '--by', memberId, '--format', 'json'], server, agent({ TM8_BASE_URL: proxyUrl }));
    const unmerged = errorOf('gate: gate_pr_unmerged_or_ci_red (1 PR)', open, 6);
    expect(wire).toHaveLength(2);
    expect((unmerged.error as Json).reason).toBe('gate_pr_unmerged_or_ci_red');
    expect((unmerged.error as Json).prs).toEqual([expect.objectContaining({ url, state: expect.any(String), ci: null })]);
  }, 120_000);

  it('use_complete_command: transition to done, no extra read', async () => {
    const id = await createFull('task', 'Error fixture use complete');
    wire = [];
    const r = await cli(['task', 'transition', id, 'done', '--format', 'json'], server, agent({ TM8_BASE_URL: proxyUrl }));
    const receipt = errorOf('gate: use_complete_command', r, 6);
    expect((receipt.error as Json).reason).toBe('use_complete_command');
    expect(wire).toHaveLength(1);
  }, 120_000);
});

describe('forbidden / not_found (§9.6)', () => {
  it('not_found exits 5 with code, requestId — and no entity fields', async () => {
    const missing = randomUUID();
    const r = await cli(['task', 'transition', missing, 'working', '--format', 'json'], server, agent());
    const receipt = errorOf('not_found (task transition)', r, 5);
    expect(receipt).toMatchObject({ op: 'task.transition', id: missing, error: { code: 'not_found', retryable: false } });
    expect(typeof (receipt.error as Json).requestId).toBe('string');
    expect(Object.keys(receipt).sort()).toEqual(['error', 'id', 'ok', 'op', 'schemaVersion']);
  }, 120_000);

  it('forbidden exits 4 and names the actor it refused', async () => {
    const id = await createFull('task', 'Error fixture forbidden');
    const stranger = randomUUID();
    const r = await cli(['task', 'transition', id, 'working', '--as', stranger, '--format', 'json'], server, agent());
    // A stranger is refused as forbidden (or, on a node that hides existence, not_found).
    expect([4, 5]).toContain(r.code);
    const receipt = errorOf(`${r.code === 4 ? 'forbidden' : 'not_found'} (--as stranger)`, r, r.code);
    const error = receipt.error as Json;
    expect(error.actor).toBe(stranger);
    expect(JSON.stringify(receipt)).not.toContain('Error fixture forbidden');
  }, 120_000);
});

describe('message delivery (§9.7)', () => {
  it('a stored batch that did not reach a live session is ok:true with an undelivered count', async () => {
    const r = await cli(['message', 'send', '--to', sessionId, 'are you there?', '--format', 'json'], server, agent());
    expect(r.code, r.stderr).toBe(0);
    const line = r.stdout.slice(0, -1);
    expect(line).not.toContain('\n');
    const receipt = JSON.parse(line) as Json;
    expect(receipt).toMatchObject({ ok: true, op: 'message.send', stored: true });
    const delivery = receipt.delivery as Json[];
    expect(delivery.length).toBeGreaterThan(0);
    const undelivered = delivery.filter((d) => d.status === 'undelivered').length;
    const warning = (receipt.warnings as Json[]).find((w) => w.code === 'undelivered');
    if (undelivered > 0) expect(warning).toEqual({ code: 'undelivered', count: undelivered });
    else expect(warning).toBeUndefined();
    sizes.push(`| message send, 1 session target (${delivery.map((d) => d.status).join(',')}) | ${Buffer.byteLength(line)} |`);
  }, 120_000);

  it('--wait settled exits exactly as --full does, with ONE receipt line on stdout', async () => {
    // Exit 11 itself needs an ACCEPTED live copy that then fails to settle
    // delivered, which a scratch node without a PTY host cannot stage (the
    // row is `undelivered` at post time and owes no settlement). The exit-11
    // path is driven with a stub in test/receipt-error.test.ts; here the
    // real node proves receipt mode changes no exit code on this path.
    const argv = ['message', 'send', '--to', sessionId, '--wait', 'settled', '--timeout', '20', '--format', 'json'];
    const r = await cli([...argv, 'settle?'], server, agent());
    const full = await cli([...argv, 'settle? (full)', '--full'], server, agent());
    expect(r.code, r.stderr).toBe(full.code);
    expect(r.stdout.split('\n')).toHaveLength(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, stored: true });
  }, 120_000);
});

describe('ambiguous outcome (§9.8): the answer is lost after the write landed', () => {
  it('entity create: outcome unknown, mutationId echoed; replaying `next` creates no duplicate', async () => {
    const title = `Error fixture lost answer ${randomUUID().slice(0, 8)}`;
    loseAnswerOf = 'POST /v2/entities';
    let r;
    try {
      r = await cli(['entity', 'create', 'task', title, ...S(), '--parent', parentId, '--format', 'json'], server, agent({ TM8_BASE_URL: proxyUrl }));
    } finally {
      loseAnswerOf = undefined;
    }
    const receipt = errorOf('ambiguous transport (entity create)', r, 7);
    expect(receipt.error).toMatchObject({ code: 'transport', outcome: 'unknown', retryable: true });
    expect(typeof receipt.mutationId).toBe('string');
    expect(receipt.next).toContain(`--mutation-id ${String(receipt.mutationId)}`);

    const replay = await cli(shellSplit(String(receipt.next)), server, agent());
    expect(replay.code, replay.stderr).toBe(0);
    const replayed = JSON.parse(replay.stdout) as Json;
    expect(replayed).toMatchObject({ ok: true, op: 'entity.create', title });
    // On success the id shows only because the caller passed it — here, via `next` (D4.7).
    expect(replayed.mutationId).toBe(receipt.mutationId);
    const rows = await psql(
      `select count(*) from public.tasks t join public.entities e on e.id = t.entity_id
        where t.title = '${title}' and e.deleted_at is null`,
    );
    expect(rows.stdout.trim(), rows.stderr).toBe('1');
  }, 120_000);

  it('message send: replaying `next` stores the message once', async () => {
    const anchor = await createFull('task', 'Error fixture lost message');
    const body = `lost answer ${randomUUID()}`;
    loseAnswerOf = 'POST /v2/messages';
    let r;
    try {
      r = await cli(['message', 'send', '--to', anchor, body, '--format', 'json'], server, agent({ TM8_BASE_URL: proxyUrl }));
    } finally {
      loseAnswerOf = undefined;
    }
    const receipt = errorOf('ambiguous transport (message send)', r, 7);
    const replay = await cli(shellSplit(String(receipt.next)), server, agent());
    expect(replay.code, replay.stderr).toBe(0);
    expect((JSON.parse(replay.stdout) as Json).batch).toBe(receipt.mutationId); // messageBatchId == clientMutationId
    const listed = await cli(['message', 'list', anchor, '--format', 'json', '--full'], server);
    const items = (JSON.parse(listed.stdout) as { items: { content: { body: string } }[] }).items;
    expect(items.filter((m) => m.content.body === body)).toHaveLength(1);
  }, 120_000);
});

describe('error receipt sizes (reported)', () => {
  it('prints bytes per case', async () => {
    expect(sizes.length).toBeGreaterThan(0);
    process.stderr.write(['', '| error receipt case | minified bytes |', '|---|---|', ...sizes, ''].join('\n'));
    await server.assertBindCoherent();
  });
});
