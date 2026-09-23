/**
 * `tm8.receipt.v1` — the phase-1 CLI projection (spec doc 01a0cf2e), unit
 * level: the pure projection per op, the Output modes, the mode resolver, and
 * the two commands a scratch Server cannot run (`session spawn|terminate`),
 * driven against a stub Server. The eight others also run against a REAL
 * Server in `test/integration/receipt.test.ts`.
 *
 * Fixtures are shaped from real results: the work_session detail is a trimmed
 * copy of a live session's (`entity get --full`), keeping every field the
 * projection reads and a representative share of what it drops.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { parseInvocation, splitCommandPath } from '../src/args.js';
import { loadLocalConfig, resolveContext, sessionContextFromEnv } from '../src/context.js';
import { errorLines, exitCodeFor } from '../src/errors.js';
import { createOutput, type OutputFormat } from '../src/output.js';
import {
  clampTitle,
  deprecationNotice,
  renderReceiptHuman,
  resolveReceiptMode,
  successReceipt,
  type Receipt,
  type ReceiptMode,
} from '../src/receipt.js';
import type { CommandModule } from '../src/run.js';

// ── fixtures ────────────────────────────────────────────────────────────────

const TASK = '01a0cf19-583f-7287-ada2-2fc20c6dca7c';
const PARENT = '01a0cd01-fcaf-77cb-8559-b35d26e3b530';
const ME = '01a0cb4c-c0d8-79e7-b63f-edb646e8013c';
const SESSION = '01a0cf13-2629-7698-8994-0d1b5b7eb513';
const WORKTREE = '01a0cf13-1625-74a1-9e5c-fa41c8eaf093';
const PR = '01a0cf19-fd27-7bd6-80fe-bbf517dd7d49';
const TYPICAL_TITLE = 'THROWAWAY receipt fixture B (delete me)';
const TITLE_80 = 'An eighty character task title that exercises the worst case receipt budget, ok.';
const TITLE_95 = `${TITLE_80} and then some more`;
const WORKTREE_PATH =
  `/Users/subhang/.local/share/tm8/data/worktrees/019fb10e-8498-7189-8911-dd26c4307915/${WORKTREE}`;

const actor = {
  id: ME, kind: 'team_member', displayName: 'Opus 5.5 1M Teammate', avatar: null, role: null,
  ownerMemberId: '019fd231-f829-7639-931e-fd6ffae1a481', isAgent: true,
};

function summary(id: string, kind: string, title: string, state: Record<string, unknown>, version = 1) {
  return {
    id, spaceId: '019fb748-0068-76dc-9869-1bb36133c554', kind, title, parentId: PARENT, position: 0,
    visibility: 'space', version, activityAt: '2026-09-23T16:29:15Z', createdAt: '2026-09-23T16:20:00Z',
    updatedAt: '2026-09-23T16:29:15Z', deletedAt: null, createdBy: actor, category: 'in_progress',
    counters: { children: 0, comments: 6, attachments: 0 }, state, badges: [],
  };
}

function edge(id: string, type: string, source: unknown, target: unknown) {
  return { id, type, source, target, props: {}, createdBy: actor, createdAt: '2026-09-23T16:29:15Z', updatedAt: '2026-09-23T16:29:15Z' };
}

function taskDetail(opts: { title?: string; version?: number; status?: string; outgoing?: unknown[] } = {}) {
  const base = summary(TASK, 'task', opts.title ?? TYPICAL_TITLE, {
    kind: 'task', status: opts.status ?? 'working', priority: 'medium', axes: {}, assignees: [actor],
    acceptance: { total: 2, completed: 2 }, completionGate: 'none',
  }, opts.version ?? 3);
  const parent = summary(PARENT, 'task', 'parent', { kind: 'task', status: 'working' });
  return {
    ...base,
    capabilities: { canEdit: true, canDelete: true, canComplete: true },
    content: { kind: 'task', description: 'a body that must never reach a receipt '.repeat(20), acceptanceCriteria: [] },
    hierarchy: { parent, path: [parent], children: [] },
    connections: { outgoing: opts.outgoing ?? [], incoming: [] },
  };
}

const completedBy = edge('01a0cf1a-5c11-7a2e-8f00-3c1d2b9e0a11', 'completed_by', { id: TASK }, summary(ME, 'team_member', 'Opus', { kind: 'team_member' }));
const prSummary = summary(PR, 'pull_request', 'subhangR/tm8#653', {
  kind: 'pull_request', repository: 'subhangR/tm8', number: 653, state: 'open',
  url: 'https://github.com/subhangR/tm8/pull/653', stale: false,
});
const tracks = edge('01a0cf19-fd29-71af-99de-a9da3bfe0f2a', 'tracks', { id: TASK }, prSummary);

function sessionDetail(opts: { title?: string; status?: string; endedKind?: string | null } = {}) {
  const base = summary(SESSION, 'work_session', opts.title ?? 'Receipts 1A worker', {
    kind: 'work_session', skills: { native: [], indexed: [], skipped: [], scannedAt: '2026-09-23T18:28:12.397Z' },
    status: opts.status ?? 'running', agentTool: 'claude-code', model: 'claude-opus-5[1m]', shareMode: 'space',
    driveMode: 'owner', startedAt: '2026-09-23T18:28:23.083Z', exitedAt: null, sessionKind: 'agent',
    checkoutBranch: `tm8/${WORKTREE}`, workdirMode: 'worktree', endedKind: opts.endedKind ?? null, endedReason: null,
    teammate: { ...actor, via: { sessionId: SESSION } },
  });
  const worktree = summary(WORKTREE, 'worktree', `tm8/${WORKTREE}`, {
    kind: 'worktree', status: 'active', branch: `tm8/${WORKTREE}`, baseRef: 'origin/main',
    baseCommitOid: 'b02a8a7a43a1694f7c93d5c322807adfe7fbe6e2', projectId: '019fb10e-8498-7189-8911-dd26c4307915',
  });
  const task = summary('01a0cf12-955d-77fb-adb0-6334f2d0124b', 'task', 'the task', { kind: 'task', status: 'working' });
  return {
    ...base,
    capabilities: { canEdit: true },
    content: { kind: 'work_session', nodeId: '127.0.0.1:7778', launchProjectId: '019fb10e-8498-7189-8911-dd26c4307915', workingOn: [], transcriptDoc: null },
    hierarchy: { parent: null, path: [], children: [] },
    connections: {
      outgoing: [
        { type: 'in_worktree', direction: 'outgoing', label: 'in_worktree', edges: [edge('01a0cf86-a3fa-70ce-90f4-19677d5a6030', 'in_worktree', { id: SESSION }, worktree)] },
        { type: 'working_on', direction: 'outgoing', label: 'working_on', edges: [edge('01a0cf86-a3fb-70ce-90f4-19677d5a6031', 'working_on', { id: SESSION }, task)] },
      ],
      incoming: [],
    },
  };
}

const commandResult = (entity: unknown, patches: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  entity,
  activity: { id: '01a0cf1a-0000-7000-8000-000000000001', verb: 'changed', actor },
  patches,
  ...extra,
});

function messageView(id: string, body: string, root: string | null) {
  return {
    ...summary(id, 'message', body.slice(0, 200), {
      kind: 'message', anchorId: TASK, rootMessageId: root, author: actor, messageBatchId: 'f557a023-c419-4ade-a67b-6c743b579764',
    }),
    content: { kind: 'message', body, mentions: [], attachments: [] },
    replyCount: 0,
  };
}

const BODY_1025 = `receipt body ${'z'.repeat(1012)}`;
const batchResult = (delivery?: unknown[]) => ({
  messageBatchId: 'f557a023-c419-4ade-a67b-6c743b579764',
  messages: [messageView('01a0cf1a-3d2f-725e-a906-7a90b6b86afa', BODY_1025, null)],
  ...(delivery ? { delivery } : {}),
});

const bytes = (r: Receipt): number => Buffer.byteLength(`${JSON.stringify(r)}\n`, 'utf8');
const FORBIDDEN = ['hierarchy', 'connections', 'content', 'capabilities', 'patches', 'changed', 'body'];

function expectLean(r: Receipt): void {
  const line = JSON.stringify(r);
  for (const key of FORBIDDEN) expect(line).not.toContain(`"${key}":`);
  expect(line).not.toContain('must never reach a receipt');
  expect(line).not.toContain('zzzzzzzz');
  expect(r.schemaVersion).toBe('tm8.receipt.v1');
  expect(r.ok).toBe(true);
  expect(r.warnings).toEqual(expect.any(Array));
}

// ── the projection, per op (§9.1, §9.2, §9.13, §7.3) ─────────────────────────

describe('successReceipt: per op', () => {
  it('task.complete: gate, completed_by ref, version.from from --expect-version, status.to only', () => {
    const r = successReceipt(
      'task.complete',
      commandResult(taskDetail({ status: 'done', outgoing: [{ type: 'completed_by', edges: [completedBy] }] }), [taskDetail(), summary(ME, 'team_member', 'Opus', {})]),
      { expectedVersion: 2, completerIds: [ME] },
    );
    expect(r).toEqual({
      schemaVersion: 'tm8.receipt.v1', ok: true, op: 'task.complete', id: TASK, kind: 'task', title: TYPICAL_TITLE,
      version: { from: 2, to: 3 }, status: { to: 'done' }, gate: { kind: 'none', result: 'passed' },
      refs: [{ kind: 'edge', type: 'completed_by', id: '01a0cf1a-5c11-7a2e-8f00-3c1d2b9e0a11', to: ME }],
      warnings: [],
    });
    expectLean(r);
    expect(bytes(r)).toBeLessThanOrEqual(500);
  });

  it('task.transition: no --expect-version, so version.to alone; no status.from; refs []', () => {
    const r = successReceipt('task.transition', commandResult(taskDetail({ version: 2 }), [taskDetail()]));
    expect(r.version).toEqual({ to: 2 });
    expect(r.status).toEqual({ to: 'working' });
    expect(r.refs).toEqual([]);
    expect(r).not.toHaveProperty('changed');
    expectLean(r);
    expect(bytes(r)).toBeLessThanOrEqual(500);
  });

  it('task.link-pr: the pull_request {kind,id,url} and its tracks edge (§4.2, §5)', () => {
    const r = successReceipt(
      'task.link-pr',
      commandResult(taskDetail({ version: 2, outgoing: [{ type: 'tracks', edges: [tracks] }] }), [taskDetail(), prSummary]),
      { url: 'https://github.com/subhangR/tm8/pull/653' },
    );
    expect(r.refs).toEqual([
      { kind: 'pull_request', id: PR, url: 'https://github.com/subhangR/tm8/pull/653' },
      { kind: 'edge', type: 'tracks', id: '01a0cf19-fd29-71af-99de-a9da3bfe0f2a' },
    ]);
    expectLean(r);
    expect(bytes(r)).toBeLessThanOrEqual(500);
  });

  it('task.link-commit: a commit carries no url on its state, so the argv url is used', () => {
    const commit = summary('01a0cf19-fd27-7bd6-80fe-bbf517dd7d50', 'commit', 'abc', { kind: 'commit', repository: 'r', sha: 'abc', message: 'm' });
    const r = successReceipt('task.link-commit', commandResult(taskDetail(), [taskDetail(), commit]), { url: 'https://github.com/o/r/commit/abc' });
    expect(r.refs).toEqual([{ kind: 'commit', id: '01a0cf19-fd27-7bd6-80fe-bbf517dd7d50', url: 'https://github.com/o/r/commit/abc' }]);
  });

  it('entity.create: parentId, version.to 1, status.to open, created_in ref', () => {
    const r = successReceipt(
      'entity.create',
      commandResult(taskDetail({ version: 1, status: 'open' }), [taskDetail()]),
      { refs: [{ kind: 'edge', type: 'created_in', id: '01a0cf19-58c1-743c-9822-cbd391dca6f5' }] },
    );
    expect(r).toMatchObject({ parentId: PARENT, version: { to: 1 }, status: { to: 'open' } });
    expect(r.refs).toEqual([{ kind: 'edge', type: 'created_in', id: '01a0cf19-58c1-743c-9822-cbd391dca6f5' }]);
    expectLean(r);
    expect(bytes(r)).toBeLessThanOrEqual(500);
  });

  it('entity.update: version.from == --expect-version, and NEVER changed:[] from a projection', () => {
    const r = successReceipt('entity.update', commandResult(taskDetail({ version: 2 })), { expectedVersion: 2 });
    // Even when to == from (the silent no-op of spec §2.5), phase 1 cannot
    // verify a no-op, so it says nothing about one.
    expect(r.version).toEqual({ from: 2, to: 2 });
    expect(r).not.toHaveProperty('changed');
    expect(r.warnings).toEqual([]);
  });

  it('message.send: stored, batch, bodyChars + 12-hex bodySha256, delivery rows; never the body (§9.7)', () => {
    const r = successReceipt('message.send', batchResult([
      { targetMessageId: '01a0cf1a-3d2f-725e-a906-7a90b6b86afa', targetWorkSessionId: SESSION, status: 'accepted', deliveryId: 'd1' },
      { targetMessageId: '01a0cf1a-3d2f-725e-a906-7a90b6b86afa', targetWorkSessionId: WORKTREE, status: 'undelivered', reason: 'session_not_live' },
    ]));
    expect(r.messages).toEqual([{
      id: '01a0cf1a-3d2f-725e-a906-7a90b6b86afa', anchor: TASK, root: null, bodyChars: 1025,
      bodySha256: createHash('sha256').update(BODY_1025, 'utf8').digest('hex').slice(0, 12),
    }]);
    expect(r.delivery).toEqual([
      { message: '01a0cf1a-3d2f-725e-a906-7a90b6b86afa', session: SESSION, status: 'accepted' },
      { message: '01a0cf1a-3d2f-725e-a906-7a90b6b86afa', session: WORKTREE, status: 'undelivered', reason: 'session_not_live' },
    ]);
    expect(r).toMatchObject({ op: 'message.send', stored: true, batch: 'f557a023-c419-4ade-a67b-6c743b579764' });
    expectLean(r);
    // Two delivery rows: 500 + 120 B for the row beyond the first (§7.3).
    expect(bytes(r)).toBeLessThanOrEqual(620);
  });

  it('message.reply: root is the thread root; bodyChars counts code points', () => {
    const body = 'réponse ✓ 👍';
    const r = successReceipt('message.reply', {
      messageBatchId: 'b', messages: [messageView('m2', body, '01a0cf1a-3d2f-725e-a906-7a90b6b86afa')],
    });
    expect(r.messages).toEqual([expect.objectContaining({ root: '01a0cf1a-3d2f-725e-a906-7a90b6b86afa', bodyChars: Array.from(body).length })]);
    expect(r).not.toHaveProperty('delivery'); // absent means nobody was owed a live copy
  });

  it('session.spawn: teammate, model, tasks, workdir {mode,path}, branch — worst case ≤ 640 B', () => {
    const r = successReceipt('session.spawn', commandResult(sessionDetail({ title: TITLE_95 })), { workdirPath: WORKTREE_PATH });
    expect(r).toMatchObject({
      op: 'session.spawn', id: SESSION, kind: 'work_session', status: { to: 'running' }, teammate: ME,
      model: 'claude-opus-5[1m]', tasks: ['01a0cf12-955d-77fb-adb0-6334f2d0124b'],
      workdir: { mode: 'worktree', path: WORKTREE_PATH }, branch: `tm8/${WORKTREE}`, titleTruncated: true,
    });
    expect(r).not.toHaveProperty('accessMode'); // not on the result; phase 2 supplies it
    // As in §5's spawn example: no version, no refs (tasks/workdir are the rows).
    expect(r).not.toHaveProperty('version');
    expect(r).not.toHaveProperty('refs');
    expectLean(r);
    // The worktree path IS the worst-case extra (§7.3), so spawn is measured
    // against the 640 B cap, with an 80-char title and with a short one.
    expect(bytes(r)).toBeLessThanOrEqual(640);
    expect(bytes(successReceipt('session.spawn', commandResult(sessionDetail()), { workdirPath: WORKTREE_PATH }))).toBeLessThanOrEqual(640);
    // Without the path it is an ordinary typical fixture.
    expect(bytes(successReceipt('session.spawn', commandResult(sessionDetail())))).toBeLessThanOrEqual(500);
  });

  it('session.terminate: status.to and ended; never status.from', () => {
    const r = successReceipt('session.terminate', commandResult(sessionDetail({ status: 'exited', endedKind: 'terminated' })));
    expect(r).toMatchObject({ op: 'session.terminate', status: { to: 'exited' }, ended: 'terminated' });
    expect(r.status).not.toHaveProperty('from');
    expectLean(r);
    expect(bytes(r)).toBeLessThanOrEqual(500);
  });

  it('worst case, entity-shaped: an 80+ char title plus link-pr refs and a warning stays ≤ 640 B', () => {
    const r = successReceipt(
      'task.link-pr',
      commandResult(taskDetail({ title: TITLE_95, outgoing: [{ type: 'tracks', edges: [tracks] }] }), [prSummary]),
    );
    expect(r.titleTruncated).toBe(true);
    expect(Array.from(String(r.title))).toHaveLength(80);
    expect(bytes(r)).toBeLessThanOrEqual(640);
  });
});

describe('passthrough (§9.13) and limits', () => {
  it('undo and server warnings are carried verbatim; CLI-verified warnings follow them', () => {
    const undo = { token: 'undo_abc', label: 'restore title', expiresAt: '2026-09-23T17:00:00Z' };
    const serverWarning = { code: 'no_change', message: "content key 'body' is not a task field", extra: [1] };
    const r = successReceipt(
      'entity.update',
      { ...commandResult(taskDetail()), undo, warnings: [serverWarning] },
      { expectedVersion: 3, warnings: [{ code: 'session_link_failed', message: 'x' }] },
    );
    expect(r.undo).toEqual(undo);
    expect(r.warnings).toEqual([serverWarning, { code: 'session_link_failed', message: 'x' }]);
  });

  it('titles clamp to 80 code points and say so; shorter ones are untouched', () => {
    expect(clampTitle(TITLE_80)).toEqual({ title: TITLE_80 });
    const cut = clampTitle(TITLE_95);
    expect(cut.titleTruncated).toBe(true);
    expect(Array.from(cut.title)).toHaveLength(80);
  });

  it('multi-row fields cap at 16 with truncated:true and the real count', () => {
    const messages = Array.from({ length: 20 }, (_, i) => messageView(`m${i}`, 'b', null));
    const r = successReceipt('message.send', { messageBatchId: 'b', messages });
    expect(r.messages).toHaveLength(16);
    expect(r).toMatchObject({ truncated: true, messageCount: 20 });
  });
});

describe('human line (§4.4)', () => {
  it('one line, the same facts', () => {
    const r = successReceipt('task.complete', commandResult(taskDetail({ status: 'done', outgoing: [{ type: 'completed_by', edges: [completedBy] }] })), { expectedVersion: 2, completerIds: [ME] });
    const line = renderReceiptHuman(r);
    expect(line).not.toContain('\n');
    expect(line).toContain(`${TASK} task "${TYPICAL_TITLE}" v2→v3 done gate:none`);
    expect(line).toContain(`completed_by 01a0cf1a-5c11-7a2e-8f00-3c1d2b9e0a11 →${ME}`);
  });

  it('an undelivered live copy is called out as NOT DELIVERED (D3.2)', () => {
    const r = successReceipt('message.send', batchResult([
      { targetMessageId: 'm', targetWorkSessionId: SESSION, status: 'undelivered', reason: 'session_not_live' },
    ]));
    const line = renderReceiptHuman(r);
    expect(line).not.toContain('\n');
    expect(line).toContain(`${SESSION} NOT DELIVERED (session_not_live)`);
    expect(line).toContain('1025ch sha:');
  });

  it('spawn names the worktree path and branch', () => {
    const line = renderReceiptHuman(successReceipt('session.spawn', commandResult(sessionDetail()), { workdirPath: WORKTREE_PATH }));
    expect(line).toContain(`worktree:${WORKTREE_PATH}`);
    expect(line).toContain(`branch:tm8/${WORKTREE}`);
  });
});

// ── Output.mutation: the modes (§9.10, §9.11) ────────────────────────────────

function render(mode: ReceiptMode | undefined, format: OutputFormat, renderMode: 'full' | 'terse' = 'full') {
  let stdout = '';
  let stderr = '';
  const out = createOutput({
    format, render: renderMode, ...(mode ? { receipts: mode } : {}),
    streams: { stdout: (c) => { stdout += String(c); }, stderr: (c) => { stderr += c; } },
  });
  const dto = commandResult(taskDetail({ version: 2 }), [taskDetail()]);
  out.mutation('task.transition', dto, () => 'legacy human', () => successReceipt('task.transition', dto));
  return { stdout, stderr, dto };
}

describe('Output.mutation', () => {
  it('receipt mode prints ONE minified line under json and jsonl alike; --terse changes nothing', () => {
    const json = render('receipt', 'json');
    const jsonl = render('receipt', 'jsonl');
    const terse = render('receipt', 'json', 'terse');
    expect(json.stdout.split('\n')).toHaveLength(2);
    expect(JSON.stringify(JSON.parse(json.stdout))).toBe(json.stdout.trimEnd());
    expect(jsonl.stdout).toBe(json.stdout);
    expect(terse.stdout).toBe(json.stdout);
    expect(json.stderr).toBe('');
  });

  it('full mode is byte-identical to Output.data — today\'s `--format json --full`', () => {
    const viaMutation = render('full', 'json');
    let direct = '';
    createOutput({ format: 'json', render: 'full', streams: { stdout: (c) => { direct += String(c); }, stderr: () => {} } })
      .data(viaMutation.dto, () => '');
    expect(viaMutation.stdout).toBe(direct);
    expect(viaMutation.stderr).toBe('');
  });

  it('an Output built with no mode behaves exactly as before receipts (full, no notice)', () => {
    expect(render(undefined, 'json')).toEqual(render('full', 'json'));
  });

  it('deprecated mode: today\'s result plus exactly one stderr line naming --full, json/jsonl only', () => {
    const json = render('deprecated', 'json');
    expect(json.stdout).toBe(render('full', 'json').stdout);
    expect(json.stderr).toBe(`${deprecationNotice('task.transition')}\n`);
    expect(json.stderr).toContain('--full');
    const human = render('deprecated', 'human');
    expect(human.stdout).toBe('legacy human\n');
    expect(human.stderr).toBe('');
  });

  it('deprecated mode keeps today\'s render, --terse included', () => {
    expect(render('deprecated', 'json', 'terse').stdout).toBe(render('full', 'json', 'terse').stdout);
  });
});

describe('resolveReceiptMode (D5.1)', () => {
  const base = { full: false, agentContext: true, journalClass: 'agent', env: {} };
  it('agent context + agent class → receipt', () => expect(resolveReceiptMode(base)).toBe('receipt'));
  it('--full always wins', () => expect(resolveReceiptMode({ ...base, full: true })).toBe('full'));
  it('a human terminal (no agent context) → deprecated', () =>
    expect(resolveReceiptMode({ ...base, agentContext: false })).toBe('deprecated'));
  it('a harness class → deprecated', () =>
    expect(resolveReceiptMode({ ...base, journalClass: 'harness' })).toBe('deprecated'));
  it('TM8_NO_RECEIPTS=1 is the kill switch', () =>
    expect(resolveReceiptMode({ ...base, env: { TM8_NO_RECEIPTS: '1' } })).toBe('deprecated'));
  it('parseInvocation resolves it from argv and env', () => {
    const saved = { ...process.env };
    try {
      process.env.TM8_SESSION_ID = SESSION;
      process.env.TM8_JOURNAL_CLASS = 'agent';
      delete process.env.TM8_NO_RECEIPTS;
      expect(parseInvocation(['task', 'transition', 'x', 'working']).globals.receipts).toBe('receipt');
      expect(parseInvocation(['task', 'transition', 'x', 'working', '--full']).globals.receipts).toBe('full');
      expect(parseInvocation(['task', 'transition', 'x', 'working', '--terse']).globals.receipts).toBe('receipt');
      process.env.TM8_JOURNAL_CLASS = 'harness';
      expect(parseInvocation(['task', 'transition', 'x', 'working']).globals.receipts).toBe('deprecated');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

// ── commands against a stub Server: spawn, terminate, link-pr chaining ──────

interface Seen { method: string; pathname: string; body: unknown }
let server: Server;
let baseUrl = '';
let seen: Seen[] = [];
let replies: Record<string, unknown> = {};

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const raw = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method ?? '', pathname: url.pathname, body: raw ? JSON.parse(raw) : undefined });
      const key = Object.keys(replies).find((k) => url.pathname.includes(k));
      res.setHeader('content-type', 'application/json');
      res.statusCode = key === undefined ? 404 : 200;
      res.end(JSON.stringify(key === undefined
        ? { error: { code: 'not_found', message: 'no stub', requestId: 'req_x', retryable: false } }
        : { data: replies[key], requestId: 'req_t' }));
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

async function modules(): Promise<CommandModule[]> {
  return [
    ...(await import('../src/commands/session.js')).SESSION_COMMANDS,
    ...(await import('../src/commands/task.js')).TASK_COMMANDS,
  ];
}

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
    const code = await mod.run({ path: match.path, args: match.args, options: inv.options, passthrough: inv.passthrough, ctx, out });
    return { code, stdout, stderr };
  } catch (error) {
    out.error(errorLines(error));
    return { code: exitCodeFor(error), stdout, stderr };
  }
}

describe('commands, receipt mode', () => {
  it('session spawn reads the worktree once for workdir.path — in receipt mode only', async () => {
    replies = {
      '/v2/execution/spawn': commandResult(sessionDetail()),
      [`/v2/entities/${WORKTREE}`]: { ...summary(WORKTREE, 'worktree', 'w', {}), content: { kind: 'worktree', path: WORKTREE_PATH } },
    };
    const r = await drive(['session', 'spawn', '--teammate', ME, '--format', 'json'], 'receipt');
    expect(r.code, r.stderr).toBe(0);
    const receipt = JSON.parse(r.stdout) as Receipt;
    expect(receipt.workdir).toEqual({ mode: 'worktree', path: WORKTREE_PATH });
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(640); // the path is the §7.3 worst-case extra
    expect(seen.map((s) => s.pathname)).toEqual(['/v2/execution/spawn', `/v2/entities/${WORKTREE}`]);

    seen = [];
    const full = await drive(['session', 'spawn', '--teammate', ME, '--format', 'json'], 'full');
    expect(full.code).toBe(0);
    expect(seen).toHaveLength(1); // --full pays for no extra read
    expect(JSON.parse(full.stdout)).toHaveProperty('entity.id', SESSION);
  });

  it('a failed worktree read drops workdir.path, never the spawn', async () => {
    replies = { '/v2/execution/spawn': commandResult(sessionDetail()) };
    const r = await drive(['session', 'spawn', '--teammate', ME, '--format', 'json'], 'receipt');
    expect(r.code, r.stderr).toBe(0);
    expect((JSON.parse(r.stdout) as Receipt).workdir).toEqual({ mode: 'worktree' });
  });

  it('session terminate prints the terminate receipt', async () => {
    replies = { '/commands/terminate': commandResult(sessionDetail({ status: 'exited', endedKind: 'terminated' })) };
    const r = await drive(['session', 'terminate', SESSION, '--yes', '--format', 'json'], 'receipt');
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ op: 'session.terminate', status: { to: 'exited' }, ended: 'terminated' });
  });

  it('task link-pr still posts created_in from the FULL result in receipt mode (§9.9)', async () => {
    replies = {
      '/commands/link-pr': commandResult(taskDetail({ outgoing: [{ type: 'tracks', edges: [tracks] }] }), [taskDetail(), prSummary]),
      '/v2/edges': { edge: { id: '01a0cf19-fd30-7000-8000-00000000c1e0', type: 'created_in' }, patches: [] },
    };
    const r = await drive(['task', 'link-pr', TASK, 'https://github.com/subhangR/tm8/pull/653', '--format', 'json'], 'receipt', { TM8_SESSION_ID: SESSION });
    expect(r.code, r.stderr).toBe(0);
    const claim = seen.find((s) => s.pathname === '/v2/edges');
    expect(claim?.body).toMatchObject({ srcId: PR, dstId: SESSION, type: 'created_in' });
    expect((JSON.parse(r.stdout) as Receipt).refs).toContainEqual(expect.objectContaining({ kind: 'pull_request', id: PR }));
  });
});
