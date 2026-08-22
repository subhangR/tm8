import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
        total_cost_usd: 0,
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
    expect(first).toContainEqual({ kind: 'text', text: 'echo:first:1' });
    expect(second).toContainEqual({ kind: 'text', text: 'echo:no-cost:2' });
    const usage = second.find((item) => item.kind === 'usage');
    expect(usage).toBeDefined();
    expect(usage).not.toHaveProperty('total_cost_usd');
    expect(second.at(-1)).toEqual({ kind: 'done', reason: 'success' });
    expect(costOnly).toContainEqual({ kind: 'usage', total_cost_usd: 0.25 });
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
      env: { TM8_FAKE_ARGV_FILE: argvFile },
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
      env: { TM8_FAKE_ARGV_FILE: argvFile },
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
