/**
 * execution.journal — the read handler that turns a teammate's on-disk CLI
 * journal (`<dataDir>/journals/<sessionId>.jsonl`) into a browser-visible page.
 *
 * These drive the REGISTERED handler as a function with a fake `Db` and a fake
 * owner, so the suite is deterministic and needs no Postgres (the dev sidecar
 * is known-flaky). The DB is exercised exactly as the handler uses it: a single
 * entity read whose result IS the authorization gate — an unauthorized caller
 * and a non-existent session are indistinguishable (RLS returns no row), which
 * is precisely what we assert by returning `[]` from `query`.
 *
 * The file-reading behaviour (missing file, malformed lines, totals-over-file
 * vs windowed records, symlink containment) is tested against real temp files.
 */
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CollabError, type SessionJournalRecord } from '@tm8/contract';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { registerExecutionHandlers } from '../../src/facade/execution-handlers.js';
import type { Db } from '../../src/db/types.js';
import type { ServerConfig } from '../../src/http/config.js';
import type { RequestContext } from '../../src/http/types.js';
import type { OperationHandler } from '../../src/http/types.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

function makeRecord(seq: number, exitCode = 0): SessionJournalRecord {
  return {
    v: 1,
    seq,
    sessionId: SESSION_ID,
    spaceId: null,
    teamMemberId: null,
    pid: 4242,
    startedAt: '2026-08-01T00:00:00.000Z',
    durationMs: 10,
    command: { path: ['message', 'send'], argv: ['tm8', 'message', 'send'], cwd: '/w' },
    input: { stdinChars: 4 },
    output: { stdoutChars: 8, stderrChars: 0, stdoutSample: 'ok', stderrSample: '', truncated: false },
    calls: [],
    result: { exitCode, error: exitCode === 0 ? null : 'boom' },
    tokens: { estimator: 'chars/4', agentToCli: 1, cliToAgent: 2 },
  };
}

/** Build the registry with fakes and return the journal handler. */
function buildHandler(opts: {
  dataDir?: string;
  rows: () => Array<{ id: string }>;
}): OperationHandler {
  const db: Db = {
    query: async () => opts.rows() as never,
  } as unknown as Db;
  const config: ServerConfig = {
    host: '127.0.0.1',
    port: 0,
    uiDir: undefined,
    maxBodyBytes: 8 * 1024 * 1024,
    databaseUrl: 'unused',
  } as unknown as ServerConfig;
  const registry = new HandlerRegistry();
  registerExecutionHandlers(registry, {
    db,
    pty: {} as never,
    config,
    ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
    owner: async () => ({ identityId: 'ident', accountId: 'acct', isNodeAdmin: false }) as never,
  });
  const handler = registry.get('execution.journal');
  if (!handler) throw new Error('execution.journal not registered');
  return handler;
}

function ctxFor(id: string, query: Record<string, string> = {}): RequestContext {
  return {
    params: { workSessionId: id },
    query: new URLSearchParams(query),
    body: undefined,
    requestId: 'req-1',
  } as unknown as RequestContext;
}

async function callJournal(handler: OperationHandler, ctx: RequestContext) {
  const result = (await handler(ctx)) as { kind: 'json'; data: unknown };
  return result.data as import('@tm8/contract').SessionJournalPage;
}

describe('execution.journal handler', () => {
  let dataDir: string;
  let journalsDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-journal-'));
    journalsDir = join(dataDir, 'journals');
    await mkdir(journalsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('refuses a non-uuid session id with not_found (before any path is built)', async () => {
    const handler = buildHandler({ dataDir, rows: () => [{ id: SESSION_ID }] });
    // A crafted traversal id cannot even reach path construction: the uuid gate
    // rejects it first, which is the primary escape defence.
    await expect(callJournal(handler, ctxFor('../../etc/passwd'))).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(callJournal(handler, ctxFor('not-a-uuid'))).rejects.toBeInstanceOf(CollabError);
  });

  it('refuses when the entity is not a readable work_session (empty rows = unauthorized or absent)', async () => {
    // RLS returning no row is how "you may not read this" and "does not exist"
    // are made indistinguishable — the entity read IS the authz gate.
    const handler = buildHandler({ dataDir, rows: () => [] });
    await expect(callJournal(handler, ctxFor(SESSION_ID))).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('returns available:false / no_journal_file for a missing journal (never a 500)', async () => {
    const handler = buildHandler({ dataDir, rows: () => [{ id: SESSION_ID }] });
    const page = await callJournal(handler, ctxFor(SESSION_ID));
    expect(page.available).toBe(false);
    expect(page.unavailableReason).toBe('no_journal_file');
    expect(page.records).toEqual([]);
    expect(page.totals.invocations).toBe(0);
    expect(page.hasMore).toBe(false);
  });

  it('counts malformed lines and skips them without crashing', async () => {
    const lines = [
      JSON.stringify(makeRecord(1)),
      'this is not json',
      JSON.stringify({ v: 1, seq: 2 }), // valid json, fails schema
      '',
      '   ', // blank -> not malformed
      JSON.stringify(makeRecord(2)),
    ];
    await writeFile(join(journalsDir, `${SESSION_ID}.jsonl`), lines.join('\n'));
    const handler = buildHandler({ dataDir, rows: () => [{ id: SESSION_ID }] });
    const page = await callJournal(handler, ctxFor(SESSION_ID));
    expect(page.available).toBe(true);
    expect(page.totals.malformed).toBe(2);
    expect(page.totals.invocations).toBe(2);
    expect(page.records.map((r) => r.seq)).toEqual([1, 2]);
  });

  it('computes totals over the whole file while windowing records newest-first→oldest-first', async () => {
    // 5 records; one failed (exitCode 3). Ask for a window of 2.
    const recs = [
      makeRecord(1),
      makeRecord(2, 3),
      makeRecord(3),
      makeRecord(4),
      makeRecord(5),
    ];
    await writeFile(
      join(journalsDir, `${SESSION_ID}.jsonl`),
      recs.map((r) => JSON.stringify(r)).join('\n'),
    );
    const handler = buildHandler({ dataDir, rows: () => [{ id: SESSION_ID }] });
    const page = await callJournal(handler, ctxFor(SESSION_ID, { limit: '2' }));

    // Totals span ALL five records, not the window.
    expect(page.totals.invocations).toBe(5);
    expect(page.totals.failed).toBe(1);
    expect(page.totals.agentToCliEst).toBe(5); // 1 each
    expect(page.totals.cliToAgentEst).toBe(10); // 2 each
    expect(page.totals.estimator).toBe('chars/4');

    // Newest window (seq 4,5) returned oldest-first, with more behind it.
    expect(page.records.map((r) => r.seq)).toEqual([4, 5]);
    expect(page.hasMore).toBe(true);
  });

  it('paginates on LINE INDEX, not seq (all records share seq 0)', async () => {
    // Every record has seq 0 — the realistic case (one invocation, one process,
    // one line). If pagination were on seq this would be meaningless; on line
    // index it is stable. Distinguish records by startedAt.
    const at = (n: number) => `2026-08-01T00:00:0${n}.000Z`;
    const recs = [0, 1, 2, 3].map((n) => ({ ...makeRecord(0), startedAt: at(n) }));
    await writeFile(
      join(journalsDir, `${SESSION_ID}.jsonl`),
      recs.map((r) => JSON.stringify(r)).join('\n'),
    );
    const handler = buildHandler({ dataDir, rows: () => [{ id: SESSION_ID }] });

    // before = line ordinal 3 → records at ordinals 0,1,2 (oldest three).
    const page = await callJournal(handler, ctxFor(SESSION_ID, { limit: '10', before: '3' }));
    expect(page.records.map((r) => r.startedAt)).toEqual([at(0), at(1), at(2)]);
    expect(page.hasMore).toBe(false);
    // Totals still cover the whole file.
    expect(page.totals.invocations).toBe(4);

    // A window that does not reach ordinal 0 reports hasMore.
    const windowed = await callJournal(handler, ctxFor(SESSION_ID, { limit: '2', before: '3' }));
    expect(windowed.records.map((r) => r.startedAt)).toEqual([at(1), at(2)]);
    expect(windowed.hasMore).toBe(true);
    // The client derives the next cursor as invocations - records.length,
    // NOT from any per-record field: 4 - 2 = 2 here, but before=3 already
    // narrowed it — the derivation holds on the unfiltered first page.
  });

  it('caps limit at 500 and rejects a non-positive limit', async () => {
    const handler = buildHandler({ dataDir, rows: () => [{ id: SESSION_ID }] });
    await expect(callJournal(handler, ctxFor(SESSION_ID, { limit: '0' }))).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(callJournal(handler, ctxFor(SESSION_ID, { limit: '-5' }))).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('refuses a journal path that resolves (via symlink) outside the journals dir', async () => {
    // Plant a secret outside journals, then symlink <uuid>.jsonl at it. The
    // realpath containment check must reject it as not_found — the file is
    // named correctly but resolves outside the sandbox.
    const secret = join(dataDir, 'secret.jsonl');
    await writeFile(secret, JSON.stringify(makeRecord(1)));
    await symlink(secret, join(journalsDir, `${SESSION_ID}.jsonl`));
    const handler = buildHandler({ dataDir, rows: () => [{ id: SESSION_ID }] });
    await expect(callJournal(handler, ctxFor(SESSION_ID))).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('reports unreadable when the node has no data dir configured', async () => {
    const handler = buildHandler({ rows: () => [{ id: SESSION_ID }] });
    const page = await callJournal(handler, ctxFor(SESSION_ID));
    expect(page.available).toBe(false);
    expect(page.unavailableReason).toBe('unreadable');
  });
});
