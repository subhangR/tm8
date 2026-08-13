/**
 * execution.transcript — the read handler that turns an agent's OWN native
 * JSONL (the session's recorded CLAUDE_CONFIG_DIR/CODEX_HOME) into a browser-visible
 * page. The third face of a session, after `execution.launch` (what it was
 * TOLD) and `execution.journal` (what it DID).
 *
 * Same test stance as `execution-journal.test.ts` and for the same reasons: the
 * REGISTERED handler is driven as a function with a fake `Db` and a fake owner,
 * so the suite is deterministic and needs no Postgres. The DB is exercised
 * exactly as the handler uses it — a single entity read whose result IS the
 * authorization gate, so an unauthorized caller and a non-existent session are
 * indistinguishable (RLS returns no row), which is what returning `[]` asserts.
 *
 * The parsing itself lives in `@tm8/execution` and is tested there against both
 * dialects. What is pinned HERE is the seam that only the handler owns:
 *   · which columns become which path components (nothing comes from the request);
 *   · that a `scratch` session's cwd is RE-DERIVED and not read from the stale
 *     `workdir_path` column;
 *   · the `last` window's default, cap and refusal;
 *   · that every dead end is an explained empty rather than a 500.
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CollabError, type SessionTranscriptPage } from '@tm8/contract';
import { encodeClaudeProjectDir } from '@tm8/execution';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { registerExecutionHandlers } from '../../src/facade/execution-handlers.js';
import type { Db } from '../../src/db/types.js';
import type { ServerConfig } from '../../src/http/config.js';
import type { OperationHandler, RequestContext } from '../../src/http/types.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const NATIVE_ID = '22222222-2222-4222-8222-222222222222';

interface SessionRow {
  native_session_id: string | null;
  workdir_path: string | null;
  workdir_mode: string | null;
  agent_tool: string | null;
  agent_config_dir: string | null;
}

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    native_session_id: NATIVE_ID,
    workdir_path: '/work/tm8',
    workdir_mode: 'project',
    agent_tool: 'claude-code',
    agent_config_dir: null,
    ...over,
  };
}

/** Build the registry with fakes and return the transcript handler. */
function buildHandler(opts: { dataDir?: string; rows: () => SessionRow[]; home: string }): OperationHandler {
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
  const handler = registry.get('execution.transcript');
  if (!handler) throw new Error('execution.transcript not registered');
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

async function call(handler: OperationHandler, ctx: RequestContext): Promise<SessionTranscriptPage> {
  const result = (await handler(ctx)) as { kind: 'json'; data: unknown };
  return result.data as SessionTranscriptPage;
}

/** Plant a claude transcript where the reader will look for the given cwd. */
async function plantClaude(home: string, cwd: string, lines: unknown[]): Promise<void> {
  const dir = join(home, '.claude', 'projects', encodeClaudeProjectDir(cwd));
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${NATIVE_ID}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n'),
  );
}

async function plantClaudeConfigDir(configDir: string, cwd: string, lines: unknown[]): Promise<void> {
  const dir = join(configDir, 'projects', encodeClaudeProjectDir(cwd));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${NATIVE_ID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
}

const userTurn = (text: string, at: string) => ({
  type: 'user',
  timestamp: at,
  message: { role: 'user', content: [{ type: 'text', text }] },
});

const assistantTurn = (text: string, at: string) => ({
  type: 'assistant',
  timestamp: at,
  message: {
    role: 'assistant',
    model: 'claude-opus-4-6',
    content: [{ type: 'text', text }],
    usage: { input_tokens: 100, output_tokens: 5 },
  },
});

describe('execution.transcript handler', () => {
  let home: string;
  let dataDir: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'tm8-transcript-home-'));
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-transcript-data-'));
    // The handler reads the NODE's home, because the transcripts belong to the
    // agents this node spawned. Redirect it so the suite never touches the
    // developer's real `~/.claude`.
    previousHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  it('refuses a non-uuid session id before any path is built', async () => {
    const handler = buildHandler({ dataDir, home, rows: () => [row()] });
    // A crafted traversal id cannot reach path construction: the uuid gate
    // rejects it first. Nothing in this handler ever accepts a caller path.
    await expect(call(handler, ctxFor('../../etc/passwd'))).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(call(handler, ctxFor('not-a-uuid'))).rejects.toBeInstanceOf(CollabError);
  });

  it('refuses when the entity is not a readable work_session (empty rows = unauthorized or absent)', async () => {
    const handler = buildHandler({ dataDir, home, rows: () => [] });
    await expect(call(handler, ctxFor(SESSION_ID))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reads a claude transcript located purely from the session row', async () => {
    await plantClaude(home, '/work/tm8', [
      userTurn('Fix the resize race.', '2026-08-01T10:00:00.000Z'),
      assistantTurn('Reading the PTY resize path.', '2026-08-01T10:00:20.000Z'),
    ]);
    const handler = buildHandler({ dataDir, home, rows: () => [row()] });
    const page = await call(handler, ctxFor(SESSION_ID));

    expect(page.available).toBe(true);
    expect(page.unavailableReason).toBeNull();
    expect(page.agentTool).toBe('claude-code');
    expect(page.entries.map((e) => e.source)).toEqual(['user', 'assistant']);
    expect(page.entries[1]?.text).toBe('Reading the PTY resize path.');
    expect(page.stats?.assistantMessages).toBe(1);
    expect(page.lastActivityAt).toBe('2026-08-01T10:00:20.000Z');
  });

  it('reads a member-credential transcript from the config dir recorded at spawn', async () => {
    const configDir = join(dataDir, 'credentials', 'id_member', 'anthropic');
    await plantClaudeConfigDir(configDir, '/work/tm8', [
      assistantTurn('Visible from the member home.', '2026-08-01T10:01:00.000Z'),
    ]);
    const handler = buildHandler({
      dataDir,
      home,
      rows: () => [row({ agent_config_dir: configDir })],
    });
    const page = await call(handler, ctxFor(SESSION_ID));
    expect(page.available).toBe(true);
    expect(page.entries[0]?.text).toBe('Visible from the member home.');
  });

  /**
   * `workdir_path` is written BEFORE the session id exists, so for a scratch
   * session it names a directory the agent never ran in. Trusting it here would
   * send the reader to an encoded project dir that does not exist and report
   * `no_transcript_file` for a session with a perfectly good transcript.
   */
  it('re-derives a scratch session’s cwd instead of trusting the stale workdir_path', async () => {
    const realCwd = join(dataDir, 'scratch', SESSION_ID);
    await plantClaude(home, realCwd, [assistantTurn('Working in scratch.', '2026-08-01T11:00:00.000Z')]);
    // The stale column points somewhere else entirely, and is also planted so
    // that a handler which trusted it would PASS with the wrong content.
    await plantClaude(home, '/work/stale', [assistantTurn('Wrong directory.', '2026-08-01T11:00:00.000Z')]);

    const handler = buildHandler({
      dataDir,
      home,
      rows: () => [row({ workdir_mode: 'scratch', workdir_path: '/work/stale' })],
    });
    const page = await call(handler, ctxFor(SESSION_ID));
    expect(page.available).toBe(true);
    expect(page.entries[0]?.text).toBe('Working in scratch.');
  });

  it('returns the explained empty for each dead end, never a 500', async () => {
    const cases: Array<[Partial<SessionRow>, SessionTranscriptPage['unavailableReason']]> = [
      [{ native_session_id: null }, 'no_native_session_id'],
      [{ agent_tool: 'echo-agent' }, 'unsupported_agent_tool'],
      [{ workdir_path: '/nowhere/at/all' }, 'no_transcript_file'],
    ];
    for (const [over, reason] of cases) {
      const handler = buildHandler({ dataDir, home, rows: () => [row(over)] });
      const page = await call(handler, ctxFor(SESSION_ID));
      expect(page.available, reason ?? 'null').toBe(false);
      expect(page.unavailableReason).toBe(reason);
      expect(page.entries).toEqual([]);
      // NULL, not a zeroed object: there are no statistics about a transcript
      // that was never found, and zeros would read as "this agent did nothing".
      expect(page.stats).toBeNull();
    }
  });

  it('windows to the newest `last` turns, defaulting to 20 and capping at 200', async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      assistantTurn(`turn ${String(i)}`, `2026-08-01T12:00:${String(i).padStart(2, '0')}.000Z`));
    await plantClaude(home, '/work/tm8', many);
    const handler = buildHandler({ dataDir, home, rows: () => [row()] });

    const dflt = await call(handler, ctxFor(SESSION_ID));
    expect(dflt.entries).toHaveLength(20);
    // Oldest-first WITHIN the newest window: turn 10 through turn 29.
    expect(dflt.entries[0]?.text).toBe('turn 10');
    expect(dflt.entries[19]?.text).toBe('turn 29');

    const three = await call(handler, ctxFor(SESSION_ID, { last: '3' }));
    expect(three.entries.map((e) => e.text)).toEqual(['turn 27', 'turn 28', 'turn 29']);

    // Above the cap is CLAMPED, not refused — a caller asking for everything
    // gets the maximum the surface will render rather than an error.
    const huge = await call(handler, ctxFor(SESSION_ID, { last: '99999' }));
    expect(huge.entries).toHaveLength(30);
  });

  it('refuses a non-positive or non-numeric `last`', async () => {
    const handler = buildHandler({ dataDir, home, rows: () => [row()] });
    for (const bad of ['0', '-5', 'many']) {
      await expect(call(handler, ctxFor(SESSION_ID, { last: bad }))).rejects.toMatchObject({
        code: 'invalid_input',
      });
    }
  });

  it('reports no_transcript_file when the node has no data dir and the session is scratch', async () => {
    // Without a data dir there is no scratch root, so the cwd cannot be derived
    // at all — and an underivable cwd is an explained empty, not a crash.
    const handler = buildHandler({ home, rows: () => [row({ workdir_mode: 'scratch' })] });
    const page = await call(handler, ctxFor(SESSION_ID));
    expect(page.available).toBe(false);
    expect(page.unavailableReason).toBe('no_transcript_file');
  });
});
