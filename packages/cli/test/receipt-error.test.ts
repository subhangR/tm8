/**
 * `tm8.receipt.v1` ERROR receipts (spec doc 01a0cf2e §4.3, §9.4–9.8, D4.x),
 * unit level: the pure projection per failure class, then the commands
 * against a stub Server — which is the only place a gate refusal's extra read
 * can be COUNTED on the wire, a transport failure can be SIMULATED, and a
 * partially delivered batch can be staged. The real-Server half is in
 * `test/integration/receipt-error.test.ts`.
 *
 * Every receipt here is also held to the §7.3 error budget: ≤ 1 KB.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { parseInvocation, splitCommandPath } from '../src/args.js';
import { loadLocalConfig, resolveContext, sessionContextFromEnv } from '../src/context.js';
import { ApiError, errorLines, exitCodeFor, ProtocolError, TransportError } from '../src/errors.js';
import { createOutput } from '../src/output.js';
import {
  errorReceipt,
  INCOMPLETE_CAP,
  isAmbiguous,
  needsGateRead,
  replayCommand,
  retryCommand,
  shellQuote,
  type ErrorReceipt,
  type ErrorReceiptInput,
} from '../src/receipt-error.js';
import { successReceipt, type ReceiptMode } from '../src/receipt.js';
import type { CommandModule } from '../src/run.js';

const TASK = '01a0cf19-583f-7287-ada2-2fc20c6dca7c';
const ME = '01a0cb4c-c0d8-79e7-b63f-edb646e8013c';
const SESSION = '01a0cf13-2629-7698-8994-0d1b5b7eb513';
const MID = '8b0e6f3a-2c1d-4f7e-9a55-0c3b1d2e4f60';
const TITLE_95 =
  'An eighty character task title that exercises the worst case receipt budget, ok. and then some more';
const ERROR_BUDGET = 1024;

/** One minified line, in the 1 KB budget; returns the parsed receipt. */
function inBudget(receipt: unknown): ErrorReceipt {
  const line = JSON.stringify(receipt);
  expect(Buffer.byteLength(line, 'utf8'), line).toBeLessThanOrEqual(ERROR_BUDGET);
  return receipt as ErrorReceipt;
}

function currentDetail(opts: { title?: string; version?: number } = {}) {
  return {
    id: TASK, kind: 'task', title: opts.title ?? 'THROWAWAY receipt fixture B (delete me)',
    version: opts.version ?? 2, updatedAt: '2026-09-23T16:29:15Z',
    state: { kind: 'task', status: 'working', completionGate: 'none' },
    content: { kind: 'task', description: 'SECRET body text '.repeat(50), acceptanceCriteria: [] },
    connections: { outgoing: [], incoming: [] },
    hierarchy: { parent: null, path: [], children: [] },
  };
}

const conflict = (details: unknown = { currentVersion: 2, current: currentDetail() }) =>
  new ApiError(409, 'version_conflict', 'version conflict', 'req_b33239_s0f', false, details);

const gateError = (reason: string) =>
  new ApiError(409, 'invariant_violation', 'all acceptance criteria must be complete first', 'req_f0a6a8_ouu', false, { sqlstate: '23514', reason });

const input = (over: Partial<ErrorReceiptInput> = {}): ErrorReceiptInput => ({
  op: 'task.complete', id: TASK, mutationId: MID, callerMutationId: false, ...over,
});

// ── pure projection ────────────────────────────────────────────────────────

describe('version_conflict (§9.4)', () => {
  const argv = ['task', 'complete', TASK, '--expect-version', '1', '--by', ME, '--format', 'json'];

  it('complete: expected/current version, current{status,title,updatedAt}, next retries at the current version', () => {
    const r = inBudget(errorReceipt(conflict(), input({ argv, expectedVersion: 1 })));
    expect(r).toMatchObject({
      schemaVersion: 'tm8.receipt.v1', ok: false, op: 'task.complete', id: TASK,
      error: {
        code: 'version_conflict', expectedVersion: 1, currentVersion: 2, requestId: 'req_b33239_s0f', retryable: false,
        current: { status: 'working', title: 'THROWAWAY receipt fixture B (delete me)', updatedAt: '2026-09-23T16:29:15Z' },
      },
    });
    expect(r.next).toBe(`tm8 task complete ${TASK} --by ${ME} --format json --expect-version 2`);
    expect(r.mutationId).toBeUndefined(); // the caller chose none
    // No entity body or graph data leaks through `current`.
    expect(JSON.stringify(r)).not.toMatch(/SECRET|connections|hierarchy|content/);
  });

  it('the retry drops the old --mutation-id (a changed expected version is a new mutation)', () => {
    const r = errorReceipt(conflict(), input({ argv: [...argv, '--mutation-id', MID], callerMutationId: true, expectedVersion: 1 }))!;
    expect(r.next).not.toContain('--mutation-id');
    expect(r.mutationId).toBe(MID); // echoed because the caller passed it
  });

  it.each([
    ['task.transition', ['task', 'transition', TASK, 'working']],
    ['task.link-pr', ['task', 'link-pr', TASK, 'https://github.com/subhangR/tm8/pull/653']],
    ['task.link-commit', ['task', 'link-commit', TASK, 'https://github.com/subhangR/tm8/commit/abc']],
  ] as const)('%s: next is a filled-in retry of the same command', (op, cmdArgv) => {
    const r = inBudget(errorReceipt(conflict(), input({ op, argv: [...cmdArgv, '--mutation-id', MID] })));
    expect(r.next).toBe(`tm8 ${cmdArgv.join(' ')}`);
    expect(r.error).toMatchObject({ code: 'version_conflict', currentVersion: 2 });
  });

  it('entity update: next is `tm8 entity context <id>`, NEVER a retry (D4.2)', () => {
    const r = inBudget(errorReceipt(conflict(), input({
      op: 'entity.update', expectedVersion: 1, argv: ['entity', 'update', TASK, '--expect-version', '1', '--title', 'x'],
    })));
    expect(r.next).toBe(`tm8 entity context ${TASK}`);
    expect(r.error.expectedVersion).toBe(1);
  });

  it('title in current clamps to 80; worst case stays ≤ 1 KB', () => {
    const r = inBudget(errorReceipt(
      conflict({ currentVersion: 7, current: currentDetail({ title: TITLE_95, version: 7 }) }),
      input({ argv: [...argv, '--as', ME, '--space', SESSION, '--mutation-id', MID], callerMutationId: true, expectedVersion: 1 }),
    ));
    expect(Array.from(String((r.error.current as { title: string }).title))).toHaveLength(80);
    expect(r.next).toContain('--expect-version 7');
  });

  it('a conflict with no current attached still names what it has, and omits the rest', () => {
    const r = errorReceipt(conflict({ currentVersion: 4 }), input({ argv, expectedVersion: 1 }))!;
    expect(r.error.currentVersion).toBe(4);
    expect(r.error).not.toHaveProperty('current');
  });
});

describe('gate failures (§9.5)', () => {
  const criteria = Array.from({ length: 14 }, (_, i) => ({
    id: `c${i}`, done: i % 7 === 0, text: `criterion ${i} `.padEnd(120, 'x'),
  }));

  it('acceptance_criteria_incomplete: incomplete[] ≤ 10, text ≤ 80, incompleteCount exact', () => {
    const r = inBudget(errorReceipt(gateError('acceptance_criteria_incomplete'), input(), { criteria }));
    expect(r.error.reason).toBe('acceptance_criteria_incomplete');
    const incomplete = r.error.incomplete as { index: number; text: string }[];
    expect(incomplete).toHaveLength(INCOMPLETE_CAP);
    expect(r.error.incompleteCount).toBe(12);
    expect(incomplete[0]).toMatchObject({ index: 1 }); // 0 is done; index is the array position
    for (const row of incomplete) expect(Array.from(row.text).length).toBeLessThanOrEqual(80);
    expect(r.truncated).toBe(true); // 12 unchecked, 10 shown — and text shortened to fit 1 KB
    expect(r.next).toBe(`tm8 entity context ${TASK}`);
  });

  it('two short criteria keep their full text and no truncated mark', () => {
    const short = [
      { text: 'Evidence archive verified by an independent re-run', done: false },
      { text: 'x', done: true },
      { text: 'Notebook linked from the parent project doc', done: false },
    ];
    const r = inBudget(errorReceipt(gateError('acceptance_criteria_incomplete'), input(), { criteria: short }));
    expect(r.error.incomplete).toEqual([{ index: 0, text: short[0]!.text }, { index: 2, text: short[2]!.text }]);
    expect(r.error.incompleteCount).toBe(2);
    expect(r).not.toHaveProperty('truncated');
  });

  it('ten 80-char criteria: the budget shortens text before it drops a row; count stays exact', () => {
    const long = Array.from({ length: 10 }, (_, i) => ({ text: `${i} `.padEnd(80, 'q'), done: false }));
    const r = inBudget(errorReceipt(gateError('acceptance_criteria_incomplete'), input(), { criteria: long }));
    expect(r.error.incomplete).toHaveLength(10);
    expect(r.error.incompleteCount).toBe(10);
    expect(r.truncated).toBe(true);
  });

  it('many tracked PRs are capped to the budget with an exact prsCount', () => {
    const pullRequests = Array.from({ length: 20 }, (_, i) => ({
      entityId: `01a0cf19-fd27-7bd6-80fe-${String(i).padStart(12, '0')}`, state: 'open',
      url: `https://github.com/example-organisation/some-repository/pull/${1000 + i}`, ciStatus: 'failing',
    }));
    const r = inBudget(errorReceipt(gateError('gate_pr_unmerged_or_ci_red'), input(), { pullRequests }));
    expect((r.error.prs as unknown[]).length).toBeGreaterThan(0);
    expect(r.error.prsCount).toBe(20);
    expect(r.truncated).toBe(true);
  });

  it('gate_no_tracked_pr: prs is [] from the refusal itself, with no read', () => {
    expect(needsGateRead(gateError('gate_no_tracked_pr'), input())).toBe(false);
    const r = inBudget(errorReceipt(gateError('gate_no_tracked_pr'), input()));
    expect(r.error).toMatchObject({ reason: 'gate_no_tracked_pr', prs: [] });
  });

  it('gate_pr_unmerged_or_ci_red on a node without the PR badge prints no prs (absent is no claim)', () => {
    const r = errorReceipt(gateError('gate_pr_unmerged_or_ci_red'), input(), {})!;
    expect(r.error).not.toHaveProperty('prs');
  });

  it.each(['gate_pr_unmerged_or_ci_red'])('%s adds prs[] {id,url,state,ci}', (reason) => {
    const pullRequests = [{
      entityId: '01a0cf19-fd27-7bd6-80fe-bbf517dd7d49', repository: 'subhangR/tm8', number: 653, title: 't',
      state: 'open', url: 'https://github.com/subhangR/tm8/pull/653', ciStatus: 'failing', mergeState: 'clean', headRef: 'x',
    }];
    const r = inBudget(errorReceipt(gateError(reason), input(), { pullRequests }));
    expect(r.error.reason).toBe(reason);
    expect(r.error.prs).toEqual(pullRequests.map((p) => ({ id: p.entityId, url: p.url, state: p.state, ci: p.ciStatus })));
  });

  it('use_complete_command needs no read and points at a read of the task', () => {
    const r = inBudget(errorReceipt(gateError('use_complete_command'), input({ op: 'task.transition' })));
    expect(r.error).toMatchObject({ code: 'invariant_violation', reason: 'use_complete_command' });
    expect(r.error).not.toHaveProperty('incomplete');
  });
});

describe('forbidden / not_found (§9.6)', () => {
  it.each([
    [403, 'forbidden', 'not_assignee_or_owner'],
    [404, 'not_found', undefined],
  ] as const)('%s %s: code, reason, requestId, actor — nothing about the row', (status, code, reason) => {
    const err = new ApiError(status, code, 'refused', 'req_x', false, {
      ...(reason ? { reason } : {}), current: currentDetail(), title: 'leak?',
    });
    const r = inBudget(errorReceipt(err, input({ actor: ME })));
    expect(Object.keys(r).sort()).toEqual(['error', 'id', 'ok', 'op', 'schemaVersion']);
    expect(r.error).toEqual({ code, ...(reason ? { reason } : {}), actor: ME, requestId: 'req_x', retryable: false });
  });
});

describe('ambiguous outcome (§9.8, D4.7)', () => {
  const argv = ['session', 'spawn', '--teammate', ME, '--task', TASK, '--format', 'json'];

  it('transport: outcome unknown, the generated mutationId echoed, next pins it', () => {
    const r = inBudget(errorReceipt(
      new TransportError('POST /v2/execution/spawn timed out after 30000ms (per-request deadline)'),
      input({ op: 'session.spawn', id: undefined, argv }),
    ));
    expect(r.error).toMatchObject({ code: 'transport', outcome: 'unknown', retryable: true });
    expect(r.mutationId).toBe(MID);
    expect(r.next).toBe(`tm8 ${argv.join(' ')} --mutation-id ${MID}`);
  });

  it('a caller-supplied id is kept, not duplicated', () => {
    const r = errorReceipt(new TransportError('reset'), input({ op: 'session.spawn', argv: [...argv, `--mutation-id=${MID}`], callerMutationId: true }))!;
    expect(r.next?.match(/--mutation-id/g)).toHaveLength(1);
    expect(r.next).toContain(`--mutation-id ${MID}`);
  });

  it('a retryable 5xx (ApiError or bare protocol 503) is ambiguous; a 429 or a 4xx is not', () => {
    expect(isAmbiguous(new ApiError(503, 'upstream_unavailable', 'down', 'req', true, {}))).toBe(true);
    expect(isAmbiguous(new ProtocolError('HTTP 503', 503))).toBe(true);
    expect(isAmbiguous(new ApiError(429, 'rate_limited', 'slow', 'req', true, {}))).toBe(false);
    expect(isAmbiguous(new ApiError(500, 'upstream_unavailable', 'rolled back', 'req', false, {}))).toBe(false);
    const r = inBudget(errorReceipt(new ApiError(503, 'upstream_unavailable', 'down', 'req_5', true, {}), input({ argv: ['task', 'transition', TASK, 'working'] })));
    expect(r.error).toMatchObject({ code: 'upstream_unavailable', outcome: 'unknown', requestId: 'req_5' });
    expect(r.mutationId).toBe(MID);
  });

  it('a refusal the Server stated never echoes a generated mutationId', () => {
    const r = errorReceipt(new ApiError(400, 'invalid_input', 'bad', 'req', false, {}), input())!;
    expect(r.mutationId).toBeUndefined();
    expect(r.error).not.toHaveProperty('outcome');
  });

  it('shell quoting round-trips awkward tokens', () => {
    expect(shellQuote("it's a body")).toBe(`'it'\\''s a body'`);
    expect(replayCommand(['message', 'send', '--to', TASK, 'hi there', '--', 'x'], MID))
      .toBe(`tm8 message send --to ${TASK} 'hi there' --mutation-id ${MID} -- x`);
    expect(retryCommand('task.complete', ['task', 'complete', TASK, '--expect-version=1'], 3))
      .toBe(`tm8 task complete ${TASK} --expect-version 3`);
  });

  it('local usage errors produce no error receipt', async () => {
    const { CliError } = await import('../src/exit.js');
    expect(errorReceipt(new CliError('bad flag', 2), input())).toBeUndefined();
  });
});

describe('partial delivery (§9.7, D4.5)', () => {
  it('a stored batch with an undelivered row is ok:true, stored:true, with an undelivered warning count', () => {
    const batch = {
      messageBatchId: 'f557a023-c419-4ade-a67b-6c743b579764',
      messages: [{ id: 'm1', state: { anchorId: TASK, rootMessageId: null }, content: { body: 'hello' } }],
      delivery: [
        { targetMessageId: 'm1', targetWorkSessionId: SESSION, status: 'accepted', deliveryId: 'd1' },
        { targetMessageId: 'm1', targetWorkSessionId: ME, status: 'undelivered', reason: 'no_live_pty' },
        { targetMessageId: 'm1', targetWorkSessionId: TASK, status: 'skipped', reason: 'self' },
      ],
    };
    const r = successReceipt('message.send', batch);
    expect(r).toMatchObject({ ok: true, stored: true });
    expect(r.warnings).toEqual([{ code: 'undelivered', count: 1 }]);
    expect((r.delivery as unknown[]).map((d) => (d as { status: string }).status)).toEqual(['accepted', 'undelivered', 'skipped']);
  });

  it('the count covers every row, past the 16-row cap', () => {
    const delivery = Array.from({ length: 20 }, (_, i) => ({ targetMessageId: 'm1', targetWorkSessionId: `s${i}`, status: 'undelivered', reason: 'x' }));
    const r = successReceipt('message.send', { messageBatchId: 'b', messages: [], delivery });
    expect(r.truncated).toBe(true);
    expect(r.delivery).toHaveLength(16);
    expect(r.warnings).toEqual([{ code: 'undelivered', count: 20 }]);
  });

  it('a fully delivered batch carries no warning', () => {
    const r = successReceipt('message.send', { messageBatchId: 'b', messages: [], delivery: [{ targetMessageId: 'm', targetWorkSessionId: 's', status: 'accepted' }] });
    expect(r.warnings).toEqual([]);
  });
});

// ── commands against a stub Server ─────────────────────────────────────────

type Reply = { status?: number; body?: unknown; destroy?: true };
interface Seen { method: string; pathname: string; body: unknown }
let server: Server;
let baseUrl = '';
let seen: Seen[] = [];
/** Route key (substring of `METHOD path`) → one reply or a queue of replies. */
let replies: Record<string, Reply | Reply[]> = {};

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const raw = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method ?? '', pathname: url.pathname, body: raw ? JSON.parse(raw) : undefined });
      const key = Object.keys(replies).find((k) => `${req.method} ${url.pathname}`.includes(k));
      const slot = key === undefined ? undefined : replies[key];
      const reply = Array.isArray(slot) ? (slot.length > 1 ? slot.shift() : slot[0]) : slot;
      if (reply?.destroy) {
        req.socket.destroy(); // the answer is lost: a transport failure
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.statusCode = reply === undefined ? 404 : reply.status ?? 200;
      res.end(JSON.stringify(reply === undefined
        ? { error: { code: 'not_found', message: 'no stub', requestId: 'req_x', retryable: false } }
        : reply.body));
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
  replies = {};
});

const ok = (data: unknown): Reply => ({ body: { data, requestId: 'req_ok' } });
const refuse = (status: number, code: string, details: unknown = {}, retryable = false): Reply => ({
  status, body: { error: { code, message: code === 'invariant_violation' ? 'all acceptance criteria must be complete first' : code, requestId: 'req_err', retryable, details } },
});

async function modules(): Promise<CommandModule[]> {
  return [
    ...(await import('../src/commands/task.js')).TASK_COMMANDS,
    ...(await import('../src/commands/entity.js')).ENTITY_COMMANDS,
    ...(await import('../src/commands/message.js')).MESSAGE_COMMANDS,
    ...(await import('../src/commands/session.js')).SESSION_COMMANDS,
  ];
}

/** Drives one command as `run()` does — argv included, errors through the funnel. */
async function drive(argv: readonly string[], mode: ReceiptMode, env: Record<string, string> = {}) {
  const mods = await modules();
  let stdout = '';
  let stderr = '';
  const streams = { stdout: (c: string | Uint8Array) => { stdout += String(c); }, stderr: (c: string) => { stderr += c; } };
  let out = createOutput({ format: 'human', streams });
  try {
    const inv = parseInvocation(argv);
    out = createOutput({ format: inv.globals.format, receipts: mode, streams });
    const match = splitCommandPath(inv.positionals, (p) => mods.some((m) => m.path.join(' ') === p.join(' ')));
    if (!match) throw new Error('no command');
    const mod = mods.find((m) => m.path.join(' ') === match.path.join(' '))!;
    const ctx = resolveContext({
      globals: inv.globals,
      session: sessionContextFromEnv({ TM8_BASE_URL: baseUrl, TM8_SPACE_ID: '11111111-1111-7111-8111-111111111111', ...env }),
      config: loadLocalConfig({}, { readFile: () => { throw new Error('no config'); } }),
    });
    const code = await mod.run({ path: match.path, args: match.args, options: inv.options, passthrough: inv.passthrough, ctx, out, argv: inv.argv });
    return { code, stdout, stderr };
  } catch (error) {
    out.error(errorLines(error));
    return { code: exitCodeFor(error), stdout, stderr };
  }
}

/** Exactly one minified line on stdout, ≤ 1 KB. */
function oneLine(stdout: string): ErrorReceipt {
  expect(stdout.endsWith('\n')).toBe(true);
  const line = stdout.slice(0, -1);
  expect(line).not.toContain('\n');
  expect(JSON.stringify(JSON.parse(line))).toBe(line);
  return inBudget(JSON.parse(line));
}

const complete = ['task', 'complete', TASK, '--expect-version', '1', '--by', ME, '--format', 'json'];

// Generous: the first test pays the cold import of four command modules, which
// on a loaded host alone can pass vitest's 5 s default.
describe('commands: error receipts on stdout, stderr and exit unchanged (D4.1)', { timeout: 60_000 }, () => {
  it('conflict: receipt mode adds exactly the stdout line; stderr and exit 6 match --full', async () => {
    replies = { 'commands/complete': refuse(409, 'version_conflict', { currentVersion: 2, current: currentDetail() }) };
    const r = await drive(complete, 'receipt');
    const full = await drive(complete, 'full');
    expect(r.code).toBe(6);
    expect(full.code).toBe(6);
    expect(r.stderr).toBe(full.stderr);
    expect(full.stdout).toBe('');
    const receipt = oneLine(r.stdout);
    expect(receipt.next).toBe(`tm8 task complete ${TASK} --by ${ME} --format json --expect-version 2`);
  });

  it('human format and non-agent callers stay stderr-only', async () => {
    replies = { 'commands/complete': refuse(409, 'version_conflict', { currentVersion: 2 }) };
    const human = await drive(complete.filter((t) => t !== '--format' && t !== 'json'), 'receipt');
    expect(human.code).toBe(6);
    expect(human.stdout).toBe('');
    const deprecated = await drive(complete, 'deprecated');
    expect(deprecated.code).toBe(6);
    expect(deprecated.stdout).toBe('');
  });

  it('jsonl prints the same one line', async () => {
    replies = { 'commands/complete': refuse(409, 'version_conflict', { currentVersion: 2 }) };
    const r = await drive(complete.map((t) => (t === 'json' ? 'jsonl' : t)), 'receipt');
    expect(r.code).toBe(6);
    expect(oneLine(r.stdout).error.code).toBe('version_conflict');
  });

  it('gate failure: EXACTLY ONE extra read, only on the failure path (§9.5)', async () => {
    const criteria = [
      { id: 'a', text: 'Evidence archive verified by an independent re-run', done: false },
      { id: 'b', text: 'done one', done: true },
      { id: 'c', text: 'Notebook linked from the parent project doc', done: false },
    ];
    replies = {
      'POST /v2/entities/': refuse(409, 'invariant_violation', { sqlstate: '23514', reason: 'acceptance_criteria_incomplete' }),
      [`GET /v2/entities/${TASK}`]: ok({ ...currentDetail(), content: { kind: 'task', acceptanceCriteria: criteria }, badges: {} }),
    };
    const r = await drive(complete, 'receipt');
    expect(r.code).toBe(6);
    expect(seen.map((s) => `${s.method} ${s.pathname}`)).toEqual([
      `POST /v2/entities/${TASK}/commands/complete`,
      `GET /v2/entities/${TASK}`,
    ]);
    expect(oneLine(r.stdout).error).toMatchObject({
      reason: 'acceptance_criteria_incomplete',
      incomplete: [{ index: 0, text: criteria[0]!.text }, { index: 2, text: criteria[2]!.text }],
      incompleteCount: 2,
    });

    // --full pays for no read.
    seen = [];
    expect((await drive(complete, 'full')).code).toBe(6);
    expect(seen).toHaveLength(1);

    // A success pays for no read either.
    seen = [];
    replies = { 'commands/complete': ok({ entity: currentDetail({ version: 2 }), patches: [] }) };
    expect((await drive(complete, 'receipt')).code).toBe(0);
    expect(seen).toHaveLength(1);
  });

  it('PR gate: prs[] from the same single read', async () => {
    replies = {
      'POST /v2/entities/': refuse(409, 'invariant_violation', { reason: 'gate_pr_unmerged_or_ci_red' }),
      [`GET /v2/entities/${TASK}`]: ok({ ...currentDetail(), badges: { pullRequests: [{ entityId: 'pr1', url: 'https://github.com/o/r/pull/1', state: 'open', ciStatus: 'failing' }] } }),
    };
    const r = await drive(complete, 'receipt');
    expect(seen).toHaveLength(2);
    expect(oneLine(r.stdout).error.prs).toEqual([{ id: 'pr1', url: 'https://github.com/o/r/pull/1', state: 'open', ci: 'failing' }]);
  });

  it('forbidden exits 4 and not_found exits 5, with the actor and no entity fields', async () => {
    replies = { 'commands/work': refuse(403, 'forbidden', { reason: 'not_assignee_or_owner' }) };
    const f = await drive(['task', 'transition', TASK, 'working', '--format', 'json', '--as', ME], 'receipt');
    expect(f.code).toBe(4);
    expect(oneLine(f.stdout)).toEqual({
      schemaVersion: 'tm8.receipt.v1', ok: false, op: 'task.transition', id: TASK,
      error: { code: 'forbidden', reason: 'not_assignee_or_owner', actor: ME, requestId: 'req_err', retryable: false },
    });
    replies = { 'PATCH /v2/entities/': refuse(404, 'not_found') };
    const n = await drive(['entity', 'update', TASK, '--expect-version', '1', '--title', 'x', '--format', 'json'], 'receipt');
    expect(n.code).toBe(5);
    expect(oneLine(n.stdout).error).toEqual({ code: 'not_found', requestId: 'req_err', retryable: false });
  });

  it('transport failure: outcome unknown, generated id echoed; replaying `next` resends THAT id (§9.8)', async () => {
    replies = { 'POST /v2/entities': { destroy: true } };
    const argv = ['entity', 'create', 'task', 'receipt replay', '--format', 'json', '--no-session-link'];
    const r = await drive(argv, 'receipt');
    expect(r.code).toBe(7);
    const receipt = oneLine(r.stdout);
    expect(receipt.error).toMatchObject({ code: 'transport', outcome: 'unknown', retryable: true });
    const sent = (seen[0]!.body as { clientMutationId: string }).clientMutationId;
    expect(receipt.mutationId).toBe(sent);
    expect(receipt.next).toBe(`tm8 entity create task 'receipt replay' --format json --no-session-link --mutation-id ${sent}`);

    // Replay `next` exactly as a shell would split it.
    replies = { 'POST /v2/entities': ok({ entity: currentDetail({ version: 1 }), patches: [] }) };
    seen = [];
    const replay = await drive([...argv, '--mutation-id', sent], 'receipt');
    expect(replay.code, replay.stderr).toBe(0);
    expect((seen[0]!.body as { clientMutationId: string }).clientMutationId).toBe(sent);
    // On success the id shows only when the caller passed it — as `next` does (D4.7).
    expect(JSON.parse(replay.stdout)).toHaveProperty('mutationId', sent);
    seen = [];
    const plain = await drive(argv, 'receipt');
    expect(plain.code, plain.stderr).toBe(0);
    expect(JSON.parse(plain.stdout)).not.toHaveProperty('mutationId');
  });

  it('a retryable 503 is ambiguous too', async () => {
    replies = { 'commands/terminate': refuse(503, 'upstream_unavailable', {}, true) };
    const r = await drive(['session', 'terminate', SESSION, '--yes', '--format', 'json'], 'receipt');
    expect(r.code).toBe(7);
    const receipt = oneLine(r.stdout);
    expect(receipt).toMatchObject({ op: 'session.terminate', id: SESSION, error: { outcome: 'unknown' } });
    expect(receipt.next).toMatch(new RegExp(`^tm8 session terminate ${SESSION} --yes --format json --mutation-id [0-9a-f-]{36}$`));
  });

  it('message send: a partially delivered batch exits 0 with one receipt line', async () => {
    replies = {
      'POST /v2/messages': ok({
        messageBatchId: 'b1',
        messages: [{ id: 'm1', state: { anchorId: SESSION, rootMessageId: null }, content: { body: 'hi' } }],
        delivery: [{ targetMessageId: 'm1', targetWorkSessionId: SESSION, status: 'undelivered', reason: 'no_live_pty' }],
      }),
    };
    const r = await drive(['message', 'send', '--to', SESSION, 'hi', '--format', 'json'], 'receipt');
    expect(r.code, r.stderr).toBe(0);
    const line = r.stdout.slice(0, -1);
    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toMatchObject({ ok: true, stored: true, warnings: [{ code: 'undelivered', count: 1 }] });
  });

  it('message send --wait settled: still exit 11, stdout still ONE receipt line', async () => {
    replies = {
      'POST /v2/messages': ok({
        messageBatchId: 'b1',
        messages: [{ id: 'm1', state: { anchorId: SESSION, rootMessageId: null }, content: { body: 'hi' } }],
        delivery: [{ targetMessageId: 'm1', targetWorkSessionId: SESSION, status: 'accepted', deliveryId: 'd1' }],
      }),
      '/delivery': ok({ deliveries: [{ targetWorkSessionId: SESSION, status: 'failed', settledAt: '2026-09-23T16:29:15Z' }] }),
    };
    const r = await drive(['message', 'send', '--to', SESSION, 'hi', '--wait', 'settled', '--format', 'json'], 'receipt');
    expect(r.code).toBe(11);
    expect(r.stdout.split('\n')).toHaveLength(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, op: 'message.send', stored: true });
    expect(r.stderr).toContain('the message IS stored; do not resend');
  });

  it('message send transport failure: next is the same send, pinned', async () => {
    replies = { 'POST /v2/messages': { destroy: true } };
    const r = await drive(['message', 'send', '--to', SESSION, 'a body', '--format', 'json'], 'receipt');
    expect(r.code).toBe(7);
    const receipt = oneLine(r.stdout);
    expect(receipt.op).toBe('message.send');
    expect(receipt.next).toBe(`tm8 message send --to ${SESSION} 'a body' --format json --mutation-id ${receipt.mutationId}`);
  });
});
