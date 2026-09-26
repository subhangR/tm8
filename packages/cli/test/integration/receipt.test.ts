/**
 * Compact receipts (`tm8.receipt.v1`, spec doc 01a0cf2e) against a REAL Server,
 * through the BUILT binary — the eight receipt commands a scratch node can run.
 * `session spawn|terminate` need a live PTY host and are covered by fixtures in
 * `test/receipt.test.ts`.
 *
 * Every receipt assertion here also asserts the §7.3 byte budget, and the last
 * test prints the before/after byte table the PR reports — per op, per
 * fixture, never summed.
 *
 * WHO IS AN AGENT. The harness stamps `TM8_JOURNAL_CLASS=harness` and scrubs
 * the ambient session identity, so a plain `cli()` call is a NON-agent caller
 * (today's result + the deprecation notice). `AGENT` restores the two signals
 * `resolveReceiptMode` requires: an agent-context marker and the agent class.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { adminUrl, assertBuilt, cli, startRealServer, type RealServer } from './harness.js';

let server: RealServer;
let spaceId = '';
let memberId = '';
let parentId = '';
/** A work_session row inserted straight into the scratch database (§9.9). */
let sessionId = '';

const agent = (extra: Record<string, string> = {}): Record<string, string> => ({
  TM8_JOURNAL_CLASS: 'agent',
  TM8_TEAM_MEMBER_ID: memberId || 'receipt-suite',
  ...extra,
});

const FORBIDDEN_KEYS = ['hierarchy', 'connections', 'content', 'capabilities', 'patches', 'entity'];
const TYPICAL_BUDGET = 500;
const WORST_BUDGET = 640;
/** The byte test's raw wire calls get the CLI's own per-request deadline (client.ts DEFAULT_TIMEOUT_MS). */
const WIRE_DEADLINE_MS = 15_000;
const LONG_TITLE =
  'Receipt worst case: an eighty-plus character title that the receipt must clamp at eighty chars';

beforeAll(async () => {
  await assertBuilt();
  server = await startRealServer('receipts');
  const res = await fetch(new URL('/v2/spaces', server.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'receipts scratch', clientMutationId: randomUUID() }),
  });
  const body = (await res.json()) as { data?: { space?: { id?: string }; memberId?: string } };
  spaceId = body.data?.space?.id ?? '';
  memberId = body.data?.memberId ?? '';
  if (!spaceId || !memberId) throw new Error(`space setup failed: ${JSON.stringify(body)}`);
  parentId = await createFull('task', 'receipt fixtures parent');

  sessionId = randomUUID();
  const made = await psql(
    `insert into public.entities(id, space_id, kind, visibility, created_by)
       select '${sessionId}', space_id, 'work_session', visibility, created_by
         from public.entities where id = '${parentId}';
     insert into public.work_sessions(entity_id, status) values ('${sessionId}', 'running');`,
  );
  if (made.code !== 0) throw new Error(`work_session fixture failed: ${made.stderr}`);
}, 240_000);

afterAll(async () => {
  await server?.stop();
});

async function psql(sql: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const listed = await psqlOn('', `select datname from pg_database where datname like 'tm8_w4_receipts_${process.pid}_%'`);
  const names = listed.stdout.trim().split('\n').filter(Boolean);
  if (names.length !== 1) throw new Error(`expected one scratch database, got ${JSON.stringify(names)}`);
  return psqlOn(String(names[0]), sql);
}

async function psqlOn(database: string, sql: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const admin = new URL(adminUrl());
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

/** Fixture setup reads the FULL result, so it passes --full (a migrated reader). */
async function createFull(kind: string, title: string): Promise<string> {
  const parent = parentId ? ['--parent', parentId] : [];
  const r = await cli(['entity', 'create', kind, title, ...S(), ...parent, '--format', 'json', '--full'], server);
  expect(r.code, r.stderr).toBe(0);
  return String((JSON.parse(r.stdout) as { entity: { id: string } }).entity.id);
}

async function versionOf(id: string): Promise<number> {
  const r = await cli(['entity', 'get', id, '--format', 'json', '--full'], server);
  return Number((JSON.parse(r.stdout) as { version: number }).version);
}

type Json = Record<string, unknown>;

/** One receipt line: exit 0, exactly one line, minified, parseable, in budget. */
function receiptOf(r: { code: number; stdout: string; stderr: string }, budget = TYPICAL_BUDGET): Json {
  expect(r.code, r.stderr).toBe(0);
  expect(r.stdout.endsWith('\n')).toBe(true);
  const line = r.stdout.slice(0, -1);
  expect(line).not.toContain('\n');
  const parsed = JSON.parse(line) as Json;
  expect(JSON.stringify(parsed)).toBe(line); // minified: re-serialising changes nothing
  expect(Buffer.byteLength(r.stdout, 'utf8'), line).toBeLessThanOrEqual(budget);
  for (const key of FORBIDDEN_KEYS) expect(line).not.toContain(`"${key}":`);
  expect(parsed.schemaVersion).toBe('tm8.receipt.v1');
  expect(parsed.ok).toBe(true);
  expect(Array.isArray(parsed.warnings)).toBe(true);
  return parsed;
}

/**
 * §9.1 common fields on an entity-shaped receipt. Phase 2 (spec 01a0d044
 * §4.1): the Server builds the receipt from its own before/after read, so a
 * fresh write always carries `version.from` and `changed`, and `from` agrees
 * with `--expect-version` whenever one was passed. A create has no before.
 */
function expectEntityHead(receipt: Json, op: string, id: string, expectedVersion?: number): void {
  expect(receipt.op).toBe(op);
  expect(receipt.id).toBe(id);
  expect(typeof receipt.kind).toBe('string');
  expect(typeof receipt.title).toBe('string');
  expect(Array.from(String(receipt.title)).length).toBeLessThanOrEqual(80);
  const version = receipt.version as { from?: number; to: number };
  expect(typeof version.to).toBe('number');
  if (expectedVersion !== undefined) expect(version.from).toBe(expectedVersion);
  if (op === 'entity.create') {
    expect(version).not.toHaveProperty('from');
    expect(receipt).not.toHaveProperty('changed');
  } else {
    expect(typeof version.from).toBe('number');
    expect(Array.isArray(receipt.changed)).toBe(true);
  }
  expect(Array.isArray(receipt.refs)).toBe(true);
}

describe('success receipts, per op (§9.1, §9.2)', () => {
  it('entity create: id, parentId, version.to, status.to — and nothing else heavy', async () => {
    const r = await cli(['entity', 'create', 'task', 'Receipt fixture create', ...S(), '--parent', parentId, '--format', 'json'], server, agent());
    const receipt = receiptOf(r);
    expectEntityHead(receipt, 'entity.create', String(receipt.id));
    expect(receipt.parentId).toBe(parentId);
    expect((receipt.version as Json).to).toBe(1);
    expect((receipt.status as Json).to).toBe('open');
  }, 120_000);

  it('entity update: version.from is exactly --expect-version', async () => {
    const id = await createFull('task', 'Receipt fixture update');
    const v = await versionOf(id);
    const r = await cli(['entity', 'update', id, '--expect-version', String(v), '--title', 'Receipt fixture updated', '--format', 'json'], server, agent());
    const receipt = receiptOf(r);
    expectEntityHead(receipt, 'entity.update', id, v);
    expect(receipt.title).toBe('Receipt fixture updated');
    expect(receipt.version).toEqual({ from: v, to: v + 1 });
    expect(receipt.changed).toEqual(['title']);
    expect(receipt.refs).toEqual([]);
  }, 120_000);

  it('entity update to the stored value: a server-verified no-op, changed:[] and NO CHANGE (§9.3)', async () => {
    const id = await createFull('task', 'Receipt fixture no-op');
    const v = await versionOf(id);
    const json = receiptOf(await cli(['entity', 'update', id, '--expect-version', String(v), '--title', 'Receipt fixture no-op', '--format', 'json'], server, agent()));
    expect(json.changed).toEqual([]);
    expect(json.version).toEqual({ from: v, to: v });
    expect((json.warnings as Json[]).map((w) => w.code)).toEqual(['no_change']);
    const human = await cli(['entity', 'update', id, '--expect-version', String(v), '--title', 'Receipt fixture no-op'], server, agent());
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toContain('NO CHANGE (');
  }, 120_000);

  it('task transition: the Server supplies version.from and status.from, and names the change', async () => {
    const id = await createFull('task', 'Receipt fixture transition');
    const r = await cli(['task', 'transition', id, 'working', '--format', 'json'], server, agent());
    const receipt = receiptOf(r);
    expectEntityHead(receipt, 'task.transition', id);
    expect(receipt.status).toEqual({ from: 'open', to: 'working' });
    expect(receipt.changed).toContain('state.status');
  }, 120_000);

  it('task complete: gate, completed_by ref to the completer, version.from', async () => {
    const id = await createFull('task', 'Receipt fixture complete');
    const v = await versionOf(id);
    const r = await cli(['task', 'complete', id, '--expect-version', String(v), '--by', memberId, '--format', 'json'], server, agent());
    const receipt = receiptOf(r);
    expectEntityHead(receipt, 'task.complete', id, v);
    expect(receipt.status).toEqual({ from: 'open', to: 'done' });
    expect(receipt.changed).toEqual(expect.arrayContaining(['state.status', 'edge:completed_by']));
    expect(receipt.gate).toEqual({ kind: 'none', result: 'passed' });
    const refs = receipt.refs as Json[];
    expect(refs).toContainEqual(expect.objectContaining({ kind: 'edge', type: 'completed_by', to: memberId }));
  }, 120_000);

  it('task link-pr / link-commit: the artifact {kind,id,url} and its tracks edge are in refs', async () => {
    const id = await createFull('task', 'Receipt fixture link');
    const prUrl = 'https://github.com/example/receipts/pull/7';
    const pr = receiptOf(await cli(['task', 'link-pr', id, prUrl, '--format', 'json'], server, agent()));
    expectEntityHead(pr, 'task.link-pr', id);
    const prRef = (pr.refs as Json[]).find((ref) => ref.kind === 'pull_request');
    expect(prRef).toMatchObject({ kind: 'pull_request', url: prUrl });
    expect(pr.refs).toContainEqual(expect.objectContaining({ kind: 'edge', type: 'tracks' }));

    const commitUrl = 'https://github.com/example/receipts/commit/0123456789abcdef0123456789abcdef01234567';
    const commit = receiptOf(await cli(['task', 'link-commit', id, commitUrl, '--format', 'json'], server, agent()));
    expectEntityHead(commit, 'task.link-commit', id);
    expect(commit.refs).toContainEqual(expect.objectContaining({ kind: 'commit' }));
  }, 120_000);

  it('message send / reply: stored, batch, bodyChars + bodySha256 of the STORED body, never the body (§9.7)', async () => {
    const anchor = await createFull('task', 'Receipt fixture thread');
    const body = `receipt body ${'x'.repeat(1012)}`; // 1,025 chars, as in the spec fixture
    const sent = receiptOf(await cli(['message', 'send', '--to', anchor, body, '--format', 'json'], server, agent()));
    expect(sent.op).toBe('message.send');
    expect(sent.stored).toBe(true);
    expect(typeof sent.batch).toBe('string');
    expect(JSON.stringify(sent)).not.toContain('xxxxxxxx');
    const [message] = sent.messages as Json[];
    expect(message).toMatchObject({ anchor, root: null, bodyChars: 1025 });

    // `message reply` needs a work-session-bound credential a scratch node
    // cannot mint; `send --reply-to` threads the same way (the reply op's own
    // receipt is covered with a fixture in test/receipt.test.ts).
    const reply = 'a short reply, 27 chars ok.';
    const replied = receiptOf(await cli(['message', 'send', '--to', anchor, '--reply-to', String(message?.id), reply, '--format', 'json'], server, agent()));
    expect(replied.op).toBe('message.send');
    const [child] = replied.messages as Json[];
    expect(child).toMatchObject({ anchor, root: message?.id, bodyChars: reply.length });

    // The digests describe what the Server STORED, read back independently.
    const listed = await cli(['message', 'list', anchor, '--format', 'json', '--full'], server);
    expect(listed.code, listed.stderr).toBe(0);
    const items = (JSON.parse(listed.stdout) as { items: Json[] }).items;
    const stored = items.find((m) => m.id === message?.id) as { content: { body: string } } | undefined;
    expect(stored).toBeDefined();
    const sha = createHash('sha256').update(stored!.content.body, 'utf8').digest('hex').slice(0, 12);
    expect(message?.bodySha256).toBe(sha);
    expect(message?.bodyChars).toBe(Array.from(stored!.content.body).length);
  }, 120_000);

  it('human format is one line carrying the same facts (§4.4)', async () => {
    const id = await createFull('task', 'Receipt fixture human');
    const v = await versionOf(id);
    const r = await cli(['entity', 'update', id, '--expect-version', String(v), '--title', 'Receipt fixture human 2'], server, agent());
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trimEnd()).not.toContain('\n');
    expect(r.stdout).toContain(id);
    expect(r.stdout).toContain(`v${v}→v${v + 1}`);
    expect(r.stdout).not.toContain('NO CHANGE');
    expect(r.stdout).toContain('"Receipt fixture human 2"');
  }, 120_000);
});

describe('worst-case budget (§7.3): 80-char title plus the longest per-op extras', () => {
  it('create and link-pr with a clamped title stay ≤ 640 B and mark the cut', async () => {
    const created = receiptOf(
      await cli(['entity', 'create', 'task', LONG_TITLE, ...S(), '--parent', parentId, '--format', 'json'], server, agent({ TM8_SESSION_ID: sessionId })),
      WORST_BUDGET,
    );
    expect(created.titleTruncated).toBe(true);
    expect(Array.from(String(created.title)).length).toBe(80);

    const linked = receiptOf(
      await cli(['task', 'link-pr', String(created.id), 'https://github.com/example-organisation/receipts-worst-case/pull/65535', '--format', 'json'], server, agent({ TM8_SESSION_ID: sessionId })),
      WORST_BUDGET,
    );
    expect(linked.titleTruncated).toBe(true);
  }, 120_000);
});

describe('chaining (§9.9): created_in still lands without --full', () => {
  it('entity create and task link-pr record the session as birth/linker', async () => {
    const made = receiptOf(
      await cli(['entity', 'create', 'task', 'Receipt fixture chained', ...S(), '--parent', parentId, '--format', 'json'], server, agent({ TM8_SESSION_ID: sessionId })),
    );
    const createdIn = (made.refs as Json[]).find((ref) => ref.type === 'created_in');
    expect(createdIn).toMatchObject({ kind: 'edge' });

    const linked = receiptOf(
      await cli(['task', 'link-pr', String(made.id), 'https://github.com/example/receipts/pull/9', '--format', 'json'], server, agent({ TM8_SESSION_ID: sessionId })),
    );
    const prId = String((linked.refs as Json[]).find((ref) => ref.kind === 'pull_request')?.id);

    // Independently: the PR's outgoing created_in edge points at the session.
    const pr = await cli(['entity', 'get', prId, '--format', 'json', '--full'], server);
    const groups = (JSON.parse(pr.stdout) as { connections: { outgoing: { type: string; edges: { target: { id: string } }[] }[] } })
      .connections.outgoing;
    const targets = groups.filter((g) => g.type === 'created_in').flatMap((g) => g.edges.map((e) => e.target.id));
    expect(targets).toContain(sessionId);
  }, 120_000);
});

describe('expansion and compat (§9.10, §9.11)', () => {
  it('--full is byte-identical to a non-agent `--format json --full` of the same result', async () => {
    const id = await createFull('task', 'Receipt fixture full');
    const mutationId = randomUUID();
    const asAgent = await cli(['task', 'transition', id, 'working', '--mutation-id', mutationId, '--format', 'json', '--full'], server, agent());
    // The same mutation id replays the stored result: same rows, same bytes.
    const asHuman = await cli(['task', 'transition', id, 'working', '--mutation-id', mutationId, '--format', 'json', '--full'], server);
    expect(asAgent.code, asAgent.stderr).toBe(0);
    expect(asAgent.stdout).toBe(asHuman.stdout);
    expect(JSON.parse(asAgent.stdout)).toHaveProperty('entity');
    expect(asAgent.stderr).toBe('');
    expect(asHuman.stderr).toBe(''); // --full never carries the notice
  }, 120_000);

  it('--terse is a no-op on receipts; jsonl prints the same single line', async () => {
    const id = await createFull('task', 'Receipt fixture terse');
    const mutationId = randomUUID();
    // All three are replays of one landed write, so they compare like for
    // like: a first call's receipt carries from/changed, a replay's cannot.
    await cli(['task', 'transition', id, 'blocked', '--mutation-id', mutationId, '--format', 'json', '--full'], server, agent());
    const plain = await cli(['task', 'transition', id, 'blocked', '--mutation-id', mutationId, '--format', 'json'], server, agent());
    const terse = await cli(['task', 'transition', id, 'blocked', '--mutation-id', mutationId, '--format', 'json', '--terse'], server, agent());
    const jsonl = await cli(['task', 'transition', id, 'blocked', '--mutation-id', mutationId, '--format', 'jsonl'], server, agent());
    const replay = receiptOf(plain);
    // A replay wrote nothing: never reported as a no-op, never given a from.
    expect(replay).not.toHaveProperty('changed');
    expect((replay.warnings as Json[]).map((w) => w.code)).toEqual(['no_write_observed']);
    expect(terse.stdout).toBe(plain.stdout);
    expect(jsonl.stdout).toBe(plain.stdout);
  }, 120_000);

  it('a non-agent caller gets today\'s full result plus ONE stderr line naming --full', async () => {
    const id = await createFull('task', 'Receipt fixture compat');
    const r = await cli(['task', 'transition', id, 'working', '--format', 'json'], server);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toHaveProperty('entity.id', id);
    const lines = r.stderr.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('--full');
    expect(lines[0]).toContain('tm8.receipt.v1');

    // Human output for a non-agent is unchanged and carries no notice.
    const human = await cli(['task', 'transition', id, 'blocked'], server);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stderr).toBe('');
    expect(human.stdout.startsWith(id)).toBe(true);
    expect(human.stdout).not.toContain('tm8.receipt.v1');
  }, 120_000);

  it('TM8_NO_RECEIPTS=1 puts an agent back on today\'s output (kill switch)', async () => {
    const id = await createFull('task', 'Receipt fixture kill switch');
    const r = await cli(['task', 'transition', id, 'working', '--format', 'json'], server, agent({ TM8_NO_RECEIPTS: '1' }));
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toHaveProperty('entity.id', id);
  }, 120_000);
});

/**
 * The PR's before/after table. "before (agent)" is what an agent printed
 * yesterday for the same call — the terse-by-default pretty JSON — reproduced
 * with the kill switch; "--full" is today's untersed result; "receipt" is this
 * change. One sibling fixture per column, so no column measures a replay.
 */
describe('byte measurements (reported, and each receipt budget-asserted)', () => {
  it('prints printed-bytes per op per fixture', async () => {
    type Mode = 'before' | 'full' | 'receipt' | 'human';
    const modeArgs = (mode: Mode): { args: string[]; env: Record<string, string> } =>
      mode === 'before' ? { args: ['--format', 'json'], env: agent({ TM8_NO_RECEIPTS: '1' }) }
        : mode === 'full' ? { args: ['--format', 'json', '--full'], env: agent() }
          : mode === 'receipt' ? { args: ['--format', 'json'], env: agent() }
            : { args: [], env: agent() };
    const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');
    const rows: string[] = [];
    const record = (op: string, fixture: string, measured: Record<Mode, number>): void => {
      rows.push(`| ${op} | ${fixture} | ${measured.before} | ${measured.full} | ${measured.receipt} | ${measured.human} |`);
    };
    const modes: Mode[] = ['before', 'full', 'receipt', 'human'];

    for (const [fixture, title] of [['typical', 'Receipt fixture B (delete me)'], ['80-char title', LONG_TITLE]] as const) {
      const m = {} as Record<Mode, number>;
      for (const mode of modes) {
        const { args, env } = modeArgs(mode);
        const r = await cli(['entity', 'create', 'task', title, ...S(), '--parent', parentId, ...args], server, env);
        expect(r.code, r.stderr).toBe(0);
        m[mode] = bytes(r.stdout);
      }
      record('entity create', fixture, m);
    }

    for (const [fixture, title] of [['typical', 'Receipt fixture B (delete me)'], ['80-char title', LONG_TITLE]] as const) {
      const perOp: Record<string, Record<Mode, number>> = {
        'task transition': {} as Record<Mode, number>,
        'entity update': {} as Record<Mode, number>,
        'task link-pr': {} as Record<Mode, number>,
        'task link-commit': {} as Record<Mode, number>,
        'task complete': {} as Record<Mode, number>,
      };
      for (const mode of modes) {
        const { args, env } = modeArgs(mode);
        const id = await createFull('task', title);
        const run = async (op: string, argv: string[]): Promise<void> => {
          const r = await cli([...argv, ...args], server, env);
          expect(r.code, `${op}/${mode}: ${r.stderr}`).toBe(0);
          if (mode === 'receipt') receiptOf(r, fixture === 'typical' ? TYPICAL_BUDGET : WORST_BUDGET);
          perOp[op]![mode] = bytes(r.stdout);
        };
        await run('task transition', ['task', 'transition', id, 'working']);
        await run('entity update', ['entity', 'update', id, '--expect-version', String(await versionOf(id)), '--content', '{"description":"measured"}']);
        await run('task link-pr', ['task', 'link-pr', id, `https://github.com/example/receipts/pull/${Math.floor(Math.random() * 1e6)}`]);
        await run('task link-commit', ['task', 'link-commit', id, `https://github.com/example/receipts/commit/${createHash('sha1').update(randomUUID()).digest('hex')}`]);
        await run('task complete', ['task', 'complete', id, '--expect-version', String(await versionOf(id)), '--by', memberId]);
      }
      for (const [op, m] of Object.entries(perOp)) record(op, fixture, m);
    }

    for (const [fixture, body] of [['1,025-char body', `m ${'y'.repeat(1023)}`], ['27-char body', 'a short reply, 27 chars ok.']] as const) {
      const m = {} as Record<Mode, number>;
      const r2 = {} as Record<Mode, number>;
      for (const mode of modes) {
        const { args, env } = modeArgs(mode);
        const anchor = await createFull('task', 'Receipt fixture thread');
        const sent = await cli(['message', 'send', '--to', anchor, body, ...args], server, env);
        expect(sent.code, sent.stderr).toBe(0);
        m[mode] = bytes(sent.stdout);
        const root = await cli(['message', 'send', '--to', anchor, 'root', '--format', 'json', '--full'], server);
        const rootId = String((JSON.parse(root.stdout) as { messages: { id: string }[] }).messages[0]?.id);
        const replied = await cli(['message', 'send', '--to', anchor, '--reply-to', rootId, body, ...args], server, env);
        expect(replied.code, replied.stderr).toBe(0);
        r2[mode] = bytes(replied.stdout);
      }
      record('message send', fixture, m);
      record('message send --reply-to', fixture, r2);
    }

    // Server response, not printed bytes (spec 01a0d044 §10): the same write
    // with and without ?return=receipt, each on its own fresh fixture, timed
    // at the HTTP call. responseChars is the whole response body.
    const wire: string[] = [];
    const call = async (method: string, path: string, body: Json, receipt: boolean): Promise<{ chars: number; ms: number }> => {
      const url = new URL(path + (receipt ? '?return=receipt' : ''), server.baseUrl);
      const t0 = performance.now();
      // The CLI's own per-request deadline. Without one, a request the
      // Server never answers holds this test until vitest's 600s timeout —
      // one hang cost a whole CI job, twice, before the JIT fix. The signal
      // covers the body read too; a bare TimeoutError names neither the call
      // nor the deadline, so it is rethrown in the CLI's own words.
      const signal = AbortSignal.timeout(WIRE_DEADLINE_MS);
      let res: Response;
      let text: string;
      try {
        res = await fetch(url, {
          method, headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, clientMutationId: randomUUID() }),
          signal,
        });
        text = await res.text();
      } catch (err) {
        if (signal.aborted) {
          throw new Error(`${method} ${url.pathname} timed out after ${WIRE_DEADLINE_MS}ms (per-request deadline)`, { cause: err });
        }
        throw err;
      }
      const ms = performance.now() - t0;
      expect(res.status, text).toBeLessThan(300);
      if (receipt) expect(JSON.parse(text).data.schemaVersion).toBe('tm8.receipt.v1');
      return { chars: text.length, ms };
    };
    const RUNS = 5;
    for (const op of ['entity update', 'task complete'] as const) {
      const per = { full: [] as { chars: number; ms: number }[], receipt: [] as { chars: number; ms: number }[] };
      for (let i = 0; i < RUNS; i++) {
        for (const mode of ['full', 'receipt'] as const) {
          const id = await createFull('task', 'Receipt fixture B (delete me)');
          const v = await versionOf(id);
          per[mode].push(op === 'entity update'
            ? await call('PATCH', `/v2/entities/${id}`, { expectedVersion: v, title: `measured ${i}` }, mode === 'receipt')
            : await call('POST', `/v2/entities/${id}/commands/complete`, { expectedVersion: v, completerIds: [memberId] }, mode === 'receipt'));
        }
      }
      const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
      for (const mode of ['full', 'receipt'] as const) {
        wire.push(`| ${op} | ${mode} | ${median(per[mode].map((x) => x.chars))} | ${median(per[mode].map((x) => x.ms)).toFixed(1)} | ${per[mode].map((x) => x.ms.toFixed(1)).join(', ')} |`);
      }
    }

    process.stderr.write(
      ['', `| op | response | responseChars (median of ${RUNS}) | durationMs (median) | durationMs (all runs) |`,
        '|---|---|---|---|---|', ...wire, ''].join('\n'),
    );
    process.stderr.write(
      ['', '| command | fixture | before: agent json (terse default) | --full | receipt json | receipt human |',
        '|---|---|---|---|---|---|', ...rows, ''].join('\n'),
    );
    await server.assertBindCoherent();
  }, 600_000);
});
