import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentRuntimeError,
  ClaudeHeadlessAdapter,
  type AgentThreadExit,
  type StartAgentThreadInput,
  type TurnItem,
} from '../src/index.js';
import { contextWindowFor } from '../src/runtime/ClaudeHeadlessAdapter.js';

const FAKE_AGENT = fileURLToPath(new URL('../harness/headless-agent.mjs', import.meta.url));
const NATIVE_SESSION_ID = '018f47f2-c091-7b2e-8f8a-101010101010';
const ALLOWED_TOOLS = ['mcp__tm8__tm8_read', 'mcp__tm8__tm8_messages'] as const;

/**
 * HOW LONG "BOOTED" TAKES, AS A MEASUREMENT RATHER THAN A GUESS.
 *
 * `awaitBoot` resolves `bootSettlementMs` after the OS-level `spawn` event, and
 * the whole point of the wait is that it must OUTLAST Node's module startup:
 * the fake agent writes its argv file and an immediate-crash wrapper throws,
 * both from module scope. A window shorter than startup does not report a
 * slower machine — it reports the WRONG ANSWER, in two directions at once:
 * `startThread` resolves before the argv file exists (`ENOENT … argv.json`) and
 * a crash that has not happened yet reads as a clean boot.
 *
 * The window used to be a flat 100 ms, which is a claim about the machine, not
 * about the adapter. MEASURED on this repo's shared build node — 4 cores, load
 * average ~17, up to eight agent sessions running suites at once — that claim
 * is false: 10 consecutive runs of this file gave 1 pass and 9 fails, the
 * failing SET differing every run (1, 2, 3, 4, 5, 6 and 7 cases), which is the
 * signature of a race and not of a defect. Every failure was one of the two
 * shapes above.
 *
 * 2000 ms is not a slower test; it is the same test with a window that fits a
 * loaded box. Nothing waits the full window on a quiet one — the cases that
 * read a file poll for it (`readRecorded` below) and return the moment it is
 * there. Override with `TM8_TEST_BOOT_SETTLEMENT_MS` to reproduce the tight
 * window deliberately.
 */
const BOOT_SETTLEMENT_MS = Number(process.env['TM8_TEST_BOOT_SETTLEMENT_MS'] ?? 2000);

/**
 * Read a file the SPAWNED process writes, waiting for it rather than assuming
 * it is already there.
 *
 * A bare `readFile` here encodes "the child has finished its module scope by
 * now", which is the same unmeasured assumption as the boot window above and
 * fails the same way under load. Polling keeps the fast path fast — on an idle
 * box the first attempt succeeds — and turns a load-induced `ENOENT` into what
 * it always was: a wait, not a result. If the deadline really does pass, the
 * error names the file, so a genuine "the child never wrote it" still reads as
 * a failure rather than as a timeout with no subject.
 */
async function readRecorded<T>(file: string, timeoutMs = BOOT_SETTLEMENT_MS * 5): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as T;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // ENOENT: not written yet. A partial write parses as invalid JSON, which
      // is also "not yet" — both are retried, and both surface if time runs out.
      const retryable = code === 'ENOENT' || error instanceof SyntaxError;
      if (!retryable || Date.now() >= deadline) {
        throw new Error(
          `the spawned agent never produced ${file} within ${String(timeoutMs)}ms: ${String(error)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function collect(stream: AsyncIterable<TurnItem>): Promise<TurnItem[]> {
  const items: TurnItem[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

async function collectIterator(iterator: AsyncIterator<TurnItem>): Promise<TurnItem[]> {
  const items: TurnItem[] = [];
  for (;;) {
    const result = await iterator.next();
    if (result.done) return items;
    items.push(result.value);
  }
}

describe('ClaudeHeadlessAdapter', () => {
  let root: string;
  let nextThread = 0;
  const adapters: ClaudeHeadlessAdapter[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tm8-headless-'));
    await writeFile(join(root, 'mcp.json'), '{}');
  });

  afterEach(async () => {
    for (const adapter of adapters) {
      for (const threadId of adapter.activeThreadIds()) await adapter.close(threadId);
    }
    await rm(root, { recursive: true, force: true });
  });

  /** A Claude config home whose projects hold NATIVE_SESSION_ID's transcript. */
  async function configHomeWithTranscript(): Promise<string> {
    const home = join(root, 'claude-home');
    const project = join(home, 'projects', '-any-project-slug');
    await mkdir(project, { recursive: true });
    await writeFile(join(project, `${NATIVE_SESSION_ID}.jsonl`), '{}\n');
    return home;
  }

  function input(overrides: Partial<StartAgentThreadInput> = {}): StartAgentThreadInput {
    nextThread += 1;
    return {
      threadId: `thread-${String(nextThread)}`,
      nativeSessionId: NATIVE_SESSION_ID,
      model: 'claude-sonnet-4-5',
      cwd: root,
      systemPrompt: 'Use only the TM8 graph tools.',
      mcpConfigPath: join(root, 'mcp.json'),
      availableTools: ['Read', 'Bash'],
      allowedTools: ALLOWED_TOOLS,
      ...overrides,
    };
  }

  function adapter(
    overrides: ConstructorParameters<typeof ClaudeHeadlessAdapter>[0] = {},
  ): ClaudeHeadlessAdapter {
    const value = new ClaudeHeadlessAdapter({
      command: process.execPath,
      commandArgs: [FAKE_AGENT],
      env: process.env,
      // Wait through actual Node module startup, not merely the OS-level spawn
      // event, so an immediate wrapper crash is classified as a boot failure.
      bootSettlementMs: BOOT_SETTLEMENT_MS,
      closeGraceMs: BOOT_SETTLEMENT_MS,
      ...overrides,
    });
    adapters.push(value);
    return value;
  }

  it('spawns the exact C6 recipe and keeps HOME ambient', async () => {
    const argvFile = join(root, 'argv.json');
    const runtime = adapter();
    const thread = input({
      env: { TM8_FAKE_ARGV_FILE: argvFile, TM8_FAKE_MARKER: 'per-thread' },
    });

    await expect(runtime.startThread(thread)).resolves.toEqual({
      threadId: thread.threadId,
      nativeSessionId: NATIVE_SESSION_ID,
    });
    const recorded = await readRecorded<{
      args: string[];
      home: string | null;
      marker: string | null;
    }>(argvFile);

    expect(recorded.args).toEqual([
      '-p',
      '--verbose',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--model',
      'claude-sonnet-4-5',
      '--setting-sources',
      '',
      '--disable-slash-commands',
      '--mcp-config',
      join(root, 'mcp.json'),
      '--strict-mcp-config',
      '--permission-mode',
      'bypassPermissions',
      '--tools',
      'Read,Bash',
      '--allowed-tools',
      ...ALLOWED_TOOLS,
      '--session-id',
      NATIVE_SESSION_ID,
      '--system-prompt',
      'Use only the TM8 graph tools.',
    ]);
    expect(recorded.args).not.toContain('--bare');
    expect(recorded.home).toBe(process.env.HOME ?? null);
    expect(recorded.marker).toBe('per-thread');
  });

  it('loads a curated skills plugin dir and enables slash commands when configured', async () => {
    const argvFile = join(root, 'skills-argv.json');
    const runtime = adapter({ pluginDir: '/opt/tm8/skills' });
    await runtime.startThread(input({ env: { TM8_FAKE_ARGV_FILE: argvFile } }));
    const recorded = await readRecorded<{ args: string[] }>(argvFile);
    // The plugin dir is passed, and the slash-command surface it resolves
    // through is NOT disabled.
    const pluginIdx = recorded.args.indexOf('--plugin-dir');
    expect(pluginIdx).toBeGreaterThanOrEqual(0);
    expect(recorded.args[pluginIdx + 1]).toBe('/opt/tm8/skills');
    expect(recorded.args).not.toContain('--disable-slash-commands');
  });

  it('keeps slash commands disabled when no skills plugin dir is configured', async () => {
    const argvFile = join(root, 'no-skills-argv.json');
    const runtime = adapter();
    await runtime.startThread(input({ env: { TM8_FAKE_ARGV_FILE: argvFile } }));
    const recorded = await readRecorded<{ args: string[] }>(argvFile);
    expect(recorded.args).toContain('--disable-slash-commands');
    expect(recorded.args).not.toContain('--plugin-dir');
  });

  it('explicitly disallows Claude built-ins when the visible native set is empty', async () => {
    const argvFile = join(root, 'orchestrate-argv.json');
    const runtime = adapter();
    const thread = input({
      availableTools: [],
      env: { TM8_FAKE_ARGV_FILE: argvFile },
    });

    await runtime.startThread(thread);
    const recorded = await readRecorded<{ args: string[] }>(argvFile);
    expect(recorded.args).not.toContain('--tools');
    expect(recorded.args).toContain('--disallowed-tools');
    for (const tool of ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch']) {
      expect(recorded.args).toContain(tool);
    }
    expect(recorded.args).toContain('--allowed-tools');
  });

  it('refuses any per-thread HOME override before spawning', async () => {
    const runtime = adapter();
    await expect(
      runtime.startThread(input({ env: { HOME: join(root, 'shadow-home') } })),
    ).rejects.toMatchObject<Partial<AgentRuntimeError>>({ code: 'invalid_input' });
    expect(runtime.activeThreadIds()).toEqual([]);
  });

  it('maps thinking, text, tool state, result, zero cost and done in order', async () => {
    const runtime = adapter();
    const thread = input();
    await runtime.startThread(thread);

    await expect(collect(runtime.sendTurn(thread.threadId, { text: 'tool' }))).resolves.toEqual([
      { kind: 'thinking', text: 'I should inspect the graph.' },
      {
        kind: 'tool_call',
        id: 'tool-1',
        name: 'mcp__tm8__tm8_read',
        args: { entityId: 'entity-1' },
        state: 'running',
      },
      {
        kind: 'tool_result',
        tool_call_id: 'tool-1',
        content: { title: 'Runtime task' },
        is_error: false,
      },
      {
        kind: 'tool_call',
        id: 'tool-1',
        name: 'mcp__tm8__tm8_read',
        args: { entityId: 'entity-1' },
        state: 'completed',
      },
      { kind: 'text', text: 'The graph answered.' },
      {
        kind: 'usage',
        input_tokens: 11,
        output_tokens: 5,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 7,
        total_cost_usd: 0.01,
      },
      { kind: 'done', reason: 'success' },
    ]);
  });

  it('keeps one hot process across turns and does not invent absent cost', async () => {
    const runtime = adapter();
    const thread = input();
    await runtime.startThread(thread);

    const first = await collect(runtime.sendTurn(thread.threadId, { text: 'first' }));
    const second = await collect(runtime.sendTurn(thread.threadId, { text: 'no-cost' }));
    const costOnly = await collect(runtime.sendTurn(thread.threadId, { text: 'cost-only' }));
    const fourth = await collect(runtime.sendTurn(thread.threadId, { text: 'fourth' }));
    const perTurn = {
      input_tokens: 11,
      output_tokens: 5,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 7,
    };
    expect(first).toContainEqual({ kind: 'text', text: 'echo:first:1' });
    expect(first).toContainEqual({ kind: 'usage', ...perTurn, total_cost_usd: 0.01 });
    expect(second).toContainEqual({ kind: 'text', text: 'echo:no-cost:2' });
    // Tokens are the step in the running totals, not the totals (22, 10, ...).
    expect(second).toContainEqual({ kind: 'usage', ...perTurn });
    expect(second.at(-1)).toEqual({ kind: 'done', reason: 'success' });
    // The previous turn reported no running cost, so this turn's step is
    // unknown: 0.27 is the process total and must not be shown as the turn's.
    // Tokens fall back to the per-turn top-level usage of a successful turn.
    expect(costOnly).toContainEqual({ kind: 'usage', ...perTurn });
    // Both running costs known again: 0.28 - 0.27.
    expect(fourth.find((item) => item.kind === 'usage')).toMatchObject({ total_cost_usd: 0.01 });
  });

  it('rejects an overlapping turn synchronously, outside the C1 stream', async () => {
    let resolveExit!: (event: AgentThreadExit) => void;
    const exited = new Promise<AgentThreadExit>((resolve) => (resolveExit = resolve));
    const runtime = adapter({ onThreadExit: resolveExit });
    const thread = input();
    await runtime.startThread(thread);
    const first = runtime.sendTurn(thread.threadId, { text: 'hang' });

    expect(() => runtime.sendTurn(thread.threadId, { text: 'second' })).toThrowError(
      expect.objectContaining({ code: 'turn_in_progress' }),
    );
    const iterator = first[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        kind: 'tool_call',
        id: 'interrupt-tool',
        name: 'mcp__tm8__slow_read',
        args: { entityId: 'probe-1' },
        state: 'running',
      },
    });
    const accepted = runtime.interrupt(thread.threadId);
    const duplicate = runtime.interrupt(thread.threadId);
    await expect(accepted).resolves.toBe(true);
    await expect(duplicate).resolves.toBe(false);
    await expect(collectIterator(iterator)).resolves.toEqual([
      {
        kind: 'tool_result',
        tool_call_id: 'interrupt-tool',
        content: 'User rejected tool use',
        is_error: true,
      },
      {
        kind: 'tool_call',
        id: 'interrupt-tool',
        name: 'mcp__tm8__slow_read',
        args: { entityId: 'probe-1' },
        state: 'error',
      },
      {
        kind: 'usage',
        input_tokens: 532,
        output_tokens: 17,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        total_cost_usd: 0.000617,
      },
      { kind: 'done', reason: 'interrupted' },
    ]);
    // The terminal result arrives before Claude's clean process exit. This is
    // the measured lost-write window: accepting another turn here would lie.
    expect(() => runtime.sendTurn(thread.threadId, { text: 'racing follow-up' })).toThrowError(
      expect.objectContaining({ code: 'thread_closing' }),
    );
    await expect(exited).resolves.toMatchObject({
      reason: 'interrupted',
      expected: true,
      exit_code: 0,
    });
    expect(runtime.hasInterruptedThreadHint(thread.threadId)).toBe(true);
    await expect(runtime.startThread(thread)).rejects.toMatchObject<Partial<AgentRuntimeError>>({
      code: 'resume_required',
    });
    await expect(
      runtime.startThread({
        ...thread,
        cwd: join(root, 'wrong-cwd'),
        resume: 'post_interrupt',
      }),
    ).rejects.toMatchObject<Partial<AgentRuntimeError>>({ code: 'resume_mismatch' });

    const argvFile = join(root, 'resume-argv.json');
    await runtime.startThread({
      ...thread,
      resume: 'post_interrupt',
      env: { TM8_FAKE_ARGV_FILE: argvFile, CLAUDE_CONFIG_DIR: await configHomeWithTranscript() },
    });
    const recorded = await readRecorded<{ args: string[] }>(argvFile);
    expect(recorded.args).toContain('--resume');
    expect(recorded.args).not.toContain('--session-id');
    expect(runtime.hasInterruptedThreadHint(thread.threadId)).toBe(false);
    await expect(
      collect(runtime.sendTurn(thread.threadId, { text: 'resumed' })),
    ).resolves.toContainEqual({ kind: 'text', text: 'echo:resumed:1' });
  });

  it('honors durable orchestrator resume authority after an adapter restart', async () => {
    const argvFile = join(root, 'restart-resume-argv.json');
    const runtime = adapter();
    const thread = input({
      resume: 'post_interrupt',
      env: { TM8_FAKE_ARGV_FILE: argvFile, CLAUDE_CONFIG_DIR: await configHomeWithTranscript() },
    });

    // This adapter has no in-memory interrupted tombstone. The durable caller
    // is authoritative after a node restart, so the vendor lookup decides.
    await runtime.startThread(thread);
    const recorded = await readRecorded<{ args: string[] }>(argvFile);
    expect(recorded.args).toContain('--resume');
    expect(recorded.args).not.toContain('--session-id');
    await expect(
      collect(runtime.sendTurn(thread.threadId, { text: 'after-node-restart' })),
    ).resolves.toContainEqual({ kind: 'text', text: 'echo:after-node-restart:1' });
  });

  it('starts a FRESH native session when the transcript to resume is gone', async () => {
    // Claude deletes transcripts after cleanupPeriodDays (30); a chat idle that
    // long used to fail every turn with "No conversation found".
    const argvFile = join(root, 'expired-resume-argv.json');
    const emptyHome = join(root, 'expired-home');
    await mkdir(join(emptyHome, 'projects', '-some-other-project'), { recursive: true });
    const runtime = adapter();
    const thread = input({
      resume: 'post_interrupt',
      env: { TM8_FAKE_ARGV_FILE: argvFile, CLAUDE_CONFIG_DIR: emptyHome },
    });
    await runtime.startThread(thread);
    const recorded = await readRecorded<{ args: string[] }>(argvFile);
    expect(recorded.args).not.toContain('--resume');
    expect(recorded.args[recorded.args.indexOf('--session-id') + 1]).toBe(NATIVE_SESSION_ID);
    await expect(
      collect(runtime.sendTurn(thread.threadId, { text: 'after-expiry' })),
    ).resolves.toContainEqual({ kind: 'text', text: 'echo:after-expiry:1' });
  });

  it('turns a mid-turn process crash into error + exactly one done and evicts it', async () => {
    let exit: AgentThreadExit | undefined;
    const runtime = adapter({ onThreadExit: (event) => (exit = event) });
    const thread = input();
    await runtime.startThread(thread);

    const items = await collect(runtime.sendTurn(thread.threadId, { text: 'crash' }));
    expect(items).toEqual([
      {
        kind: 'error',
        code: 'process_exit',
        message: 'Claude headless process exited (code 7)',
      },
      { kind: 'done', reason: 'error' },
    ]);
    expect(items.filter((item) => item.kind === 'done')).toHaveLength(1);
    expect(runtime.hasThread(thread.threadId)).toBe(false);
    expect(exit).toMatchObject({
      threadId: thread.threadId,
      exit_code: 7,
      reason: 'crashed',
      expected: false,
    });
  });

  it('maps provider failures to error, reported usage, and exactly one done', async () => {
    const runtime = adapter();
    const thread = input();
    await runtime.startThread(thread);

    const items = await collect(runtime.sendTurn(thread.threadId, { text: 'failed' }));
    expect(items).toContainEqual({
      kind: 'error',
      code: 'error_during_execution',
      message: 'synthetic provider failure',
    });
    expect(items).toContainEqual({ kind: 'usage', input_tokens: 3, output_tokens: 1 });
    expect(items.at(-1)).toEqual({ kind: 'done', reason: 'error' });
    expect(items.filter((item) => item.kind === 'done')).toHaveLength(1);
  });

  it('fails a mismatched native session id instead of silently relinking', async () => {
    const runtime = adapter();
    const thread = input();
    await runtime.startThread(thread);

    await expect(
      collect(runtime.sendTurn(thread.threadId, { text: 'session-mismatch' })),
    ).resolves.toEqual([
      {
        kind: 'error',
        code: 'native_session_mismatch',
        message: 'Claude initialized a different native session than TM8 pre-minted',
      },
      { kind: 'done', reason: 'error' },
    ]);
  });

  it('rejects an immediate boot crash and leaves no registry ghost', async () => {
    const runtime = adapter();
    const thread = input({ env: { TM8_FAKE_HEADLESS_MODE: 'boot-crash' } });
    await expect(runtime.startThread(thread)).rejects.toMatchObject<Partial<AgentRuntimeError>>({
      code: 'spawn_failed',
    });
    expect(runtime.activeThreadIds()).toEqual([]);
  });

  it('reports an idle process death through the callback and removes the registry entry', async () => {
    let resolveExit!: (event: AgentThreadExit) => void;
    const exited = new Promise<AgentThreadExit>((resolve) => (resolveExit = resolve));
    const runtime = adapter({ onThreadExit: resolveExit });
    const thread = input({
      env: {
        TM8_FAKE_HEADLESS_MODE: 'idle-crash',
        // The crash must land AFTER the boot window closes or it is a boot
        // failure and this callback is never reached. The fake's old fixed
        // 180 ms only outran the old fixed 100 ms window; both move together
        // now, so the ordering holds at any window this file is run with.
        TM8_FAKE_IDLE_CRASH_MS: String(BOOT_SETTLEMENT_MS + 500),
      },
    });
    await runtime.startThread(thread);

    await expect(exited).resolves.toMatchObject({
      threadId: thread.threadId,
      exit_code: 19,
      reason: 'crashed',
      expected: false,
    });
    expect(runtime.hasThread(thread.threadId)).toBe(false);
  });

  describe('context and per-turn usage from recorded stream shapes', () => {
    // Shapes as claude 2.1.280 emits them (probed live, haiku and opus [1m]):
    // every event of one streamed message repeats that request's usage;
    // `result.usage` is per turn; `modelUsage` and `total_cost_usd` are running
    // totals for the process; the modelUsage key is the launch model.
    const OPUS = 'claude-opus-5-5';
    const OPUS_1M = `${OPUS}[1m]`;

    function assistant(
      id: string,
      usage: Record<string, number>,
      content: unknown[],
      extra: Record<string, unknown> = {},
    ) {
      return {
        type: 'assistant',
        parent_tool_use_id: null,
        session_id: NATIVE_SESSION_ID,
        ...extra,
        message: { id, model: OPUS, role: 'assistant', usage, content, ...(extra['message'] as object) },
      };
    }

    function result(
      turnUsage: Record<string, number>,
      running: { input: number; output: number; read: number; created: number; cost: number },
      extra: Record<string, unknown> = {},
    ) {
      return {
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: NATIVE_SESSION_ID,
        usage: turnUsage,
        modelUsage: {
          [OPUS_1M]: {
            inputTokens: running.input,
            outputTokens: running.output,
            cacheReadInputTokens: running.read,
            cacheCreationInputTokens: running.created,
            costUSD: running.cost,
            contextWindow: 1_000_000,
            canonicalModel: OPUS,
          },
        },
        total_cost_usd: running.cost,
        ...extra,
      };
    }

    const request = (input: number, read: number, created: number, output = 9) => ({
      input_tokens: input,
      cache_read_input_tokens: read,
      cache_creation_input_tokens: created,
      output_tokens: output,
    });

    async function fixtureThread(turns: Record<string, unknown[]>, env: Record<string, string> = {}) {
      const file = join(root, `fixture-${String(nextThread + 1)}.json`);
      await writeFile(file, JSON.stringify(turns));
      const runtime = adapter();
      const thread = input({ model: OPUS_1M, env: { TM8_FAKE_STREAM_FIXTURE: file, ...env } });
      await runtime.startThread(thread);
      return { runtime, thread };
    }

    const contexts = (items: TurnItem[]) =>
      items.flatMap((item) => (item.kind === 'context' ? [item.context] : []));

    it('measures a multi-request turn once per request and attaches the [1m] window', async () => {
      const { runtime, thread } = await fixtureThread({
        work: [
          // Request 1: thinking and a tool call, streamed as two events that
          // repeat one usage. It must be measured once.
          assistant('msg_1', request(3, 17_000, 600), [{ type: 'thinking', thinking: 'look' }]),
          assistant('msg_1', request(3, 17_000, 600), [
            { type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a' } },
          ]),
          {
            type: 'user',
            parent_tool_use_id: null,
            message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
          },
          // Request 2: the context grew by the tool result.
          assistant('msg_2', request(1, 17_600, 900), [{ type: 'text', text: 'done' }]),
          result(request(4, 34_600, 1_500, 18), { input: 4, output: 18, read: 34_600, created: 1_500, cost: 0.05 }),
        ],
      });

      const items = await collect(runtime.sendTurn(thread.threadId, { text: 'work' }));
      const seen = contexts(items);
      // Two requests, two samples (no capacity yet: the window only arrives on
      // `result`), then the latest re-emitted with the provider's window.
      expect(seen.map((c) => [c.usedTokens, c.capacityTokens])).toEqual([
        [17_603, null],
        [18_501, null],
        [18_501, 1_000_000],
      ]);
      expect(seen.at(-1)).toMatchObject({
        usedTokens: 18_501,
        cacheReadTokens: 17_600,
        requestInputTokens: 18_501,
        capacityTokens: 1_000_000,
        model: OPUS,
        source: 'claude_request_usage',
        capacitySource: 'provider',
        unavailableReason: null,
      });
      // Per-turn usage is the SUM over the turn's requests, not the context.
      expect(items).toContainEqual({
        kind: 'usage',
        input_tokens: 4,
        output_tokens: 18,
        cache_read_input_tokens: 34_600,
        cache_creation_input_tokens: 1_500,
        total_cost_usd: 0.05,
      });
      expect(items.at(-1)).toEqual({ kind: 'done', reason: 'success' });
    });

    it('reports a 2-turn process per turn, and knows the window before turn 2 samples', async () => {
      const { runtime, thread } = await fixtureThread({
        one: [
          assistant('msg_a', request(3, 17_690, 0), [{ type: 'text', text: 'a' }]),
          result(request(3, 17_690, 0, 12), { input: 3, output: 12, read: 17_690, created: 0, cost: 0.009524 }),
        ],
        two: [
          assistant('msg_b', request(3, 21_355, 40), [{ type: 'text', text: 'b' }]),
          // Running totals: turn one plus turn two.
          result(request(3, 21_355, 40, 20), {
            input: 6,
            output: 32,
            read: 39_045,
            created: 40,
            cost: 0.0138285,
          }),
        ],
      });

      await collect(runtime.sendTurn(thread.threadId, { text: 'one' }));
      const two = await collect(runtime.sendTurn(thread.threadId, { text: 'two' }));
      expect(two).toContainEqual({
        kind: 'usage',
        input_tokens: 3,
        output_tokens: 20,
        cache_read_input_tokens: 21_355,
        cache_creation_input_tokens: 40,
        total_cost_usd: 0.0043045,
      });
      // The window is cached per thread, so turn two's sample carries it at
      // once and nothing is re-emitted on `result`.
      expect(contexts(two)).toEqual([
        expect.objectContaining({ usedTokens: 21_398, capacityTokens: 1_000_000, capacitySource: 'provider' }),
      ]);
    });

    it('skips sub-agent and synthetic messages, and never reads a missing part as zero', async () => {
      const { runtime, thread } = await fixtureThread({
        mixed: [
          assistant('msg_main', request(2, 20_000, 100), [{ type: 'text', text: 'main' }]),
          // A Task sub-agent's request runs in its own context window.
          assistant('msg_sub', request(5, 3_000, 3_000), [{ type: 'text', text: 'sub' }], {
            parent_tool_use_id: 'toolu_task',
          }),
          assistant('msg_syn', request(0, 0, 0), [{ type: 'text', text: 'No response requested.' }], {
            message: { model: '<synthetic>' },
          }),
          // A request whose usage lacks the cache parts is unknown, not 2.
          assistant('msg_partial', { input_tokens: 2, output_tokens: 1 }, [{ type: 'text', text: 'p' }]),
          result(request(4, 20_000, 100), { input: 9, output: 20, read: 23_000, created: 3_100, cost: 0.02 }),
        ],
      });

      const items = await collect(runtime.sendTurn(thread.threadId, { text: 'mixed' }));
      const seen = contexts(items);
      expect(seen.map((c) => c.usedTokens)).toEqual([20_102, null, null]);
      expect(seen[1]).toMatchObject({ cacheReadTokens: null, requestInputTokens: null, unavailableReason: 'incomplete_usage' });
      expect(items).toContainEqual({ kind: 'text', text: 'sub' });
    });

    it('clears the reading on compact_boundary until the next request measures it', async () => {
      const { runtime, thread } = await fixtureThread({
        compact: [
          assistant('msg_before', request(2, 180_000, 0), [{ type: 'text', text: 'long' }]),
          { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 180_002 } },
          assistant('msg_after', request(2, 9_000, 1_000), [{ type: 'text', text: 'short' }]),
          result(request(4, 189_000, 1_000), { input: 4, output: 18, read: 189_000, created: 1_000, cost: 0.1 }),
        ],
      });

      const seen = contexts(await collect(runtime.sendTurn(thread.threadId, { text: 'compact' })));
      expect(seen.map((c) => [c.usedTokens, c.unavailableReason])).toEqual([
        [180_002, null],
        [null, 'awaiting_new_sample'],
        [10_002, null],
        [10_002, null],
      ]);
      expect(seen.at(-1)?.capacityTokens).toBe(1_000_000);
    });

    it('takes an interrupted turn from the running totals, and a resume continues them', async () => {
      const { runtime, thread } = await fixtureThread({
        first: [
          assistant('msg_1', request(3, 10_000, 0), [{ type: 'text', text: '1' }]),
          result(request(3, 10_000, 0), { input: 3, output: 9, read: 10_000, created: 0, cost: 0.01 }),
        ],
        stopped: [
          assistant('msg_2', request(3, 11_000, 0), [{ type: 'text', text: '2' }]),
          // An aborted result zeroes the top-level usage; the totals are real.
          result({ input_tokens: 0, output_tokens: 0 }, { input: 6, output: 18, read: 21_000, created: 0, cost: 0.025 }, {
            subtype: 'error_during_execution',
            terminal_reason: 'aborted_streaming',
          }),
        ],
      });
      await collect(runtime.sendTurn(thread.threadId, { text: 'first' }));
      const stopped = await collect(runtime.sendTurn(thread.threadId, { text: 'stopped' }));
      expect(stopped.find((item) => item.kind === 'usage')).toEqual({
        kind: 'usage',
        input_tokens: 3,
        output_tokens: 9,
        cache_read_input_tokens: 11_000,
        cache_creation_input_tokens: 0,
        total_cost_usd: 0.015,
      });
      await runtime.close(thread.threadId);

      // `--resume` restores the session's running totals in the new process
      // (measured: cost 0.010661 -> 0.0133114 on the first resumed turn), so the
      // base is the last totals this adapter saw, not zero.
      const file = join(root, 'resumed.json');
      await writeFile(
        file,
        JSON.stringify({
          again: [result(request(3, 12_000, 0), { input: 9, output: 27, read: 33_000, created: 0, cost: 0.03 })],
        }),
      );
      await runtime.startThread({
        ...thread,
        resume: 'post_interrupt',
        env: { TM8_FAKE_STREAM_FIXTURE: file, CLAUDE_CONFIG_DIR: await configHomeWithTranscript() },
      });
      const again = await collect(runtime.sendTurn(thread.threadId, { text: 'again' }));
      expect(again.find((item) => item.kind === 'usage')).toMatchObject({
        input_tokens: 3,
        cache_read_input_tokens: 12_000,
        total_cost_usd: 0.005,
      });
    });

    it('does not guess a resumed turn cost when the base is unknown', async () => {
      // A node restart forgets the totals; the resumed process's first result
      // reports the whole session's cost, which is not this turn's.
      const { runtime, thread } = await fixtureThread({
        again: [result(request(3, 12_000, 0), { input: 9, output: 27, read: 33_000, created: 0, cost: 0.03 })],
      });
      await runtime.close(thread.threadId);
      await runtime.startThread({
        ...thread,
        resume: 'post_interrupt',
        env: { ...thread.env, CLAUDE_CONFIG_DIR: await configHomeWithTranscript() },
      });
      const again = await collect(runtime.sendTurn(thread.threadId, { text: 'again' }));
      expect(again.find((item) => item.kind === 'usage')).toEqual({
        kind: 'usage',
        input_tokens: 3,
        output_tokens: 9,
        cache_read_input_tokens: 12_000,
        cache_creation_input_tokens: 0,
      });
    });
    it('counts from zero when an expired transcript turns a resume into a fresh session', async () => {
      // No transcript anywhere: the adapter drops `--resume`, so the new
      // process's totals start at zero and are all this turn's.
      const { runtime, thread } = await fixtureThread({
        again: [result(request(3, 12_000, 0), { input: 3, output: 9, read: 12_000, created: 0, cost: 0.004 })],
      });
      await runtime.close(thread.threadId);
      const emptyHome = join(root, 'expired-home');
      await mkdir(join(emptyHome, 'projects'), { recursive: true });
      await runtime.startThread({
        ...thread,
        resume: 'post_interrupt',
        env: { ...thread.env, CLAUDE_CONFIG_DIR: emptyHome },
      });
      const again = await collect(runtime.sendTurn(thread.threadId, { text: 'again' }));
      expect(again.find((item) => item.kind === 'usage')).toMatchObject({ input_tokens: 3, total_cost_usd: 0.004 });
    });
  });

  it('matches a context window across the [1m] key and a dated message.model', () => {
    const usage = {
      'claude-opus-5-5[1m]': { contextWindow: 1_000_000, canonicalModel: 'claude-opus-5-5' },
      'claude-haiku-4-5-20251001': { contextWindow: 200_000, canonicalModel: 'claude-haiku-4-5' },
    };
    expect(contextWindowFor(usage, 'claude-opus-5-5', 'claude-opus-5-5[1m]')).toBe(1_000_000);
    expect(contextWindowFor(usage, 'claude-opus-5-5', null)).toBe(1_000_000);
    expect(contextWindowFor(usage, 'claude-haiku-4-5-20251001', 'claude-opus-5-5[1m]')).toBe(200_000);
    expect(contextWindowFor(usage, 'claude-haiku-4-5', null)).toBe(200_000);
    expect(contextWindowFor(usage, 'claude-sonnet-5', null)).toBeNull();
    // Two entries claiming one canonical model: ambiguous, so unknown rather
    // than whichever came first.
    expect(
      contextWindowFor(
        {
          'claude-x-1': { contextWindow: 1_000_000, canonicalModel: 'claude-x' },
          'claude-x-2': { contextWindow: 200_000, canonicalModel: 'claude-x' },
        },
        'claude-x',
        null,
      ),
    ).toBeNull();
  });

  it('closes stdin for a clean idle shutdown and makes close idempotent', async () => {
    let exit: AgentThreadExit | undefined;
    const runtime = adapter({ onThreadExit: (event) => (exit = event) });
    const thread = input();
    await runtime.startThread(thread);
    await runtime.close(thread.threadId);
    await runtime.close(thread.threadId);

    expect(runtime.hasThread(thread.threadId)).toBe(false);
    expect(exit).toMatchObject({ reason: 'closed', expected: true, exit_code: 0 });
  });
});
