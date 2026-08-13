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
      bootSettlementMs: 100,
      closeGraceMs: 100,
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
    const recorded = JSON.parse(await readFile(argvFile, 'utf8')) as {
      args: string[];
      home: string | null;
      marker: string | null;
    };

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
      '--tools',
      '',
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
    expect(first).toContainEqual({ kind: 'text', text: 'echo:first:1' });
    expect(second).toContainEqual({ kind: 'text', text: 'echo:no-cost:2' });
    const usage = second.find((item) => item.kind === 'usage');
    expect(usage).toBeDefined();
    expect(usage).not.toHaveProperty('total_cost_usd');
    expect(second.at(-1)).toEqual({ kind: 'done', reason: 'success' });
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
    expect(await runtime.interrupt(thread.threadId)).toBe(true);
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
      { kind: 'usage', input_tokens: 0, output_tokens: 0, total_cost_usd: 0.001 },
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
    const thread = input({ env: { TM8_FAKE_HEADLESS_MODE: 'idle-crash' } });
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
