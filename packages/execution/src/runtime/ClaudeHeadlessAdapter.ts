import {
  spawn as spawnChild,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { isAbsolute } from 'node:path';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type { Logger } from '../pty/types.js';
import { redactSecretTokens } from '../spawn/secret-redaction.js';
import { composeChatEnv } from './chat-env.js';
import { AsyncTurnQueue } from './AsyncTurnQueue.js';
import {
  AgentRuntimeError,
  type AgentRuntime,
  type AgentThread,
  type AgentThreadExit,
  type AgentTurnInput,
  type StartAgentThreadInput,
  type ToolCallTurnItem,
  type TurnDoneReason,
  type TurnItem,
  type UsageTurnItem,
} from './types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Match SpawnService's measured early-death window. This cannot mean "Claude
// initialized" (stream-json init is turn-framed and only follows input); it
// catches missing binaries and wrappers that die immediately after spawning.
const DEFAULT_BOOT_SETTLEMENT_MS = 150;
const DEFAULT_CLOSE_GRACE_MS = 1_000;
const MAX_STDERR_CHARS = 16_384;
const CLAUDE_BUILTIN_TOOLS = [
  'Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch',
  'NotebookEdit', 'TodoWrite', 'Task', 'TaskOutput', 'AskUserQuestion',
  'EnterPlanMode', 'ExitPlanMode',
] as const;

type JsonObject = Record<string, unknown>;

interface ActiveTurn {
  queue: AsyncTurnQueue;
  toolCalls: Map<string, ToolCallTurnItem>;
}

interface ThreadState {
  readonly input: StartAgentThreadInput;
  readonly child: ChildProcessWithoutNullStreams;
  readonly lines: ReadlineInterface;
  readonly exited: Promise<void>;
  resolveExited(): void;
  active: ActiveTurn | null;
  stderr: string;
  closeRequested: boolean;
  interruptRequested: boolean;
  unusable: boolean;
  booting: boolean;
  closed: boolean;
}

interface InterruptedThread {
  readonly nativeSessionId: string;
  readonly cwd: string;
  readonly model: string;
}

export interface ClaudeHeadlessAdapterOptions {
  /** Defaults to `claude`. Override together with commandArgs in process tests. */
  command?: string;
  /** Prefix arguments inserted before the Claude flags (for a wrapper binary). */
  commandArgs?: readonly string[];
  /** Ambient process environment. HOME is inherited from here, never per thread. */
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  bootSettlementMs?: number;
  closeGraceMs?: number;
  onThreadExit?: (event: AgentThreadExit) => void | Promise<void>;
  /**
   * A node-level Claude Code plugin directory holding the tm8-curated skills.
   * When set, the runtime loads it with `--plugin-dir` and ENABLES the slash-
   * command surface (which is what `Skill` resolves through). When absent,
   * `--disable-slash-commands` stays on and the `Skill` tool, though offered,
   * finds nothing — so chat behaves exactly as before a dir is configured.
   * NOT a settings source: this does not re-enable project hooks/permissions.
   */
  pluginDir?: string;
}

/**
 * Hot-process Claude Code runtime over its newline-delimited stream-json mode.
 *
 * One child belongs to one durable message thread. stdin remains open between
 * turns, preserving prompt cache and context, while stdout is mapped directly
 * into TM8's provider-neutral C1 union. No PTY, shell, HOME overlay, built-in
 * Claude tool, or inherited settings source enters this path.
 */
export class ClaudeHeadlessAdapter implements AgentRuntime {
  private readonly command: string;
  private readonly commandArgs: readonly string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly logger: Logger | undefined;
  private readonly bootSettlementMs: number;
  private readonly closeGraceMs: number;
  private readonly onThreadExit: ClaudeHeadlessAdapterOptions['onThreadExit'];
  private readonly pluginDir: string | undefined;
  private readonly threads = new Map<string, ThreadState>();
  /**
   * Same-process consistency hints for R8. The orchestrator's durable binding
   * is the resume authority, so absence after a node restart never blocks a
   * caller-authorized post-interrupt resume.
   */
  private readonly interruptedThreads = new Map<string, InterruptedThread>();

  constructor(options: ClaudeHeadlessAdapterOptions = {}) {
    this.command = options.command ?? 'claude';
    this.commandArgs = options.commandArgs ?? [];
    this.env = options.env ?? process.env;
    this.logger = options.logger;
    this.bootSettlementMs = options.bootSettlementMs ?? DEFAULT_BOOT_SETTLEMENT_MS;
    this.closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
    this.onThreadExit = options.onThreadExit;
    this.pluginDir = options.pluginDir?.trim() || undefined;
    if (this.bootSettlementMs < 0 || !Number.isFinite(this.bootSettlementMs)) {
      throw new AgentRuntimeError('bootSettlementMs must be a finite non-negative number', 'invalid_input');
    }
    if (this.closeGraceMs < 1 || !Number.isFinite(this.closeGraceMs)) {
      throw new AgentRuntimeError('closeGraceMs must be a finite positive number', 'invalid_input');
    }
  }

  async startThread(input: StartAgentThreadInput): Promise<AgentThread> {
    this.assertStartInput(input);
    if (this.threads.has(input.threadId)) {
      throw new AgentRuntimeError(`agent thread '${input.threadId}' is already running`, 'thread_exists');
    }
    const interrupted = this.interruptedThreads.get(input.threadId);
    if (input.resume === 'post_interrupt') {
      if (
        interrupted &&
        (interrupted.nativeSessionId !== input.nativeSessionId ||
          interrupted.cwd !== input.cwd ||
          interrupted.model !== input.model)
      ) {
        throw new AgentRuntimeError(
          `agent thread '${input.threadId}' resume config does not match its interrupted runtime`,
          'resume_mismatch',
        );
      }
    } else if (interrupted) {
      throw new AgentRuntimeError(
        `agent thread '${input.threadId}' must resume its interrupted native session`,
        'resume_required',
      );
    }

    // Own an immutable snapshot. Retaining a caller-owned object would let a
    // later `input.threadId = ...` make exit cleanup delete the wrong registry
    // key and leave a live-looking ghost behind.
    const config: StartAgentThreadInput = {
      ...input,
      availableTools: [...input.availableTools],
      allowedTools: [...input.allowedTools],
      ...(input.env ? { env: { ...input.env } } : {}),
    };

    const args = this.buildArgs(config);
    // ALLOW-LIST, never a wholesale copy. `{ ...this.env }` here handed the
    // chat child the server's own environment, which on a deployed node
    // carries `TM8_DATABASE_URL` — a SUPERUSER connection string, for which
    // every RLS policy is advisory. That was inert only while chat had no way
    // to read an environment variable; the full tool set is what makes it
    // live. See chat-env.ts for the measurement and the argument.
    const childEnv: NodeJS.ProcessEnv = { ...composeChatEnv(this.env), ...config.env };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnChild(this.command, args, {
        cwd: config.cwd,
        env: childEnv,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw this.spawnError(error);
    }

    let resolveExited!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve;
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const state: ThreadState = {
      input: config,
      child,
      lines,
      exited,
      resolveExited,
      active: null,
      stderr: '',
      closeRequested: false,
      interruptRequested: false,
      unusable: false,
      booting: true,
      closed: false,
    };
    this.threads.set(config.threadId, state);

    lines.on('line', (line) => this.handleLine(state, line));
    child.stderr.on('data', (chunk: Buffer | string) => this.captureStderr(state, chunk));
    child.on('error', (error) => this.handleProcessError(state, error));
    child.once('close', (code, signal) => this.handleProcessClose(state, code, signal));

    try {
      await this.awaitBoot(state);
      state.booting = false;
      if (config.resume === 'post_interrupt') this.interruptedThreads.delete(config.threadId);
    } catch (error) {
      state.booting = false;
      this.threads.delete(config.threadId);
      lines.close();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      if (error instanceof AgentRuntimeError) throw error;
      throw this.spawnError(error);
    }

    return { threadId: config.threadId, nativeSessionId: config.nativeSessionId };
  }

  sendTurn(threadId: string, input: AgentTurnInput): AsyncIterable<TurnItem> {
    const state = this.requireThread(threadId);
    if (state.closeRequested) {
      throw new AgentRuntimeError(`agent thread '${threadId}' is closing`, 'thread_closing');
    }
    // Measured against real Claude 2.1.212: SIGINT emits a terminal aborted
    // result, then the process drains and exits code 0. There is a short window
    // where stdin.write still returns true but no next-turn event is ever
    // emitted. Keep that window fail-fast instead of accepting a lost turn.
    if (state.interruptRequested) {
      throw new AgentRuntimeError(`agent thread '${threadId}' is closing after interrupt`, 'thread_closing');
    }
    if (state.unusable) {
      throw new AgentRuntimeError(`agent thread '${threadId}' is closing after a runtime failure`, 'thread_closing');
    }
    if (state.active) {
      throw new AgentRuntimeError(`agent thread '${threadId}' already has a turn in progress`, 'turn_in_progress');
    }
    if (typeof input.text !== 'string' || input.text.length === 0 || input.text.includes('\0')) {
      throw new AgentRuntimeError('turn text must be a non-empty string without NUL bytes', 'invalid_input');
    }

    const active: ActiveTurn = {
      queue: new AsyncTurnQueue(),
      toolCalls: new Map(),
    };
    state.active = active;

    const message = `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: input.text },
    })}\n`;
    try {
      state.child.stdin.write(message, 'utf8', (error) => {
        if (error && state.active === active) {
          this.failActiveTurn(state, 'stdin_write_failed', 'failed to deliver the user turn to Claude');
        }
      });
    } catch {
      this.failActiveTurn(state, 'stdin_write_failed', 'failed to deliver the user turn to Claude');
    }
    return active.queue;
  }

  async interrupt(threadId: string): Promise<boolean> {
    const state = this.requireThread(threadId);
    if (!state.active || state.closeRequested || state.interruptRequested || state.unusable) return false;
    state.interruptRequested = true;
    const signalled = state.child.kill('SIGINT');
    if (!signalled) state.interruptRequested = false;
    return signalled;
  }

  async close(threadId: string): Promise<void> {
    const state = this.threads.get(threadId);
    if (!state || state.closed) {
      this.interruptedThreads.delete(threadId);
      return;
    }
    state.closeRequested = true;
    if (!state.child.stdin.destroyed) state.child.stdin.end();

    if (await this.waitForExit(state, this.closeGraceMs)) return;
    state.child.kill('SIGTERM');
    if (await this.waitForExit(state, this.closeGraceMs)) return;
    state.child.kill('SIGKILL');
    if (await this.waitForExit(state, this.closeGraceMs)) return;

    throw new AgentRuntimeError(
      `agent thread '${threadId}' did not exit after stdin close, SIGTERM, and SIGKILL`,
      'close_failed',
    );
  }

  /** Read-only registry probes for health checks and deterministic tests. */
  hasThread(threadId: string): boolean {
    return this.threads.has(threadId);
  }

  activeThreadIds(): string[] {
    return [...this.threads.keys()];
  }

  /** Same-process hint only; durable resume authority belongs to the caller. */
  hasInterruptedThreadHint(threadId: string): boolean {
    return this.interruptedThreads.has(threadId);
  }

  private requireThread(threadId: string): ThreadState {
    const state = this.threads.get(threadId);
    if (!state || state.closed) {
      throw new AgentRuntimeError(`agent thread '${threadId}' is not running`, 'thread_not_found');
    }
    return state;
  }

  private assertStartInput(input: StartAgentThreadInput): void {
    this.assertText(input.threadId, 'threadId');
    this.assertText(input.model, 'model');
    this.assertText(input.systemPrompt, 'systemPrompt');
    this.assertText(input.cwd, 'cwd');
    this.assertText(input.mcpConfigPath, 'mcpConfigPath');
    if (!UUID_PATTERN.test(input.nativeSessionId)) {
      throw new AgentRuntimeError('nativeSessionId must be a UUID', 'invalid_input');
    }
    if (!isAbsolute(input.cwd)) {
      throw new AgentRuntimeError('cwd must be absolute so it stays pinned for the thread', 'invalid_input');
    }
    if (!isAbsolute(input.mcpConfigPath)) {
      throw new AgentRuntimeError('mcpConfigPath must be absolute', 'invalid_input');
    }
    if (!Array.isArray(input.allowedTools) || input.allowedTools.length === 0) {
      throw new AgentRuntimeError('allowedTools must name at least one pre-authorized tool', 'invalid_input');
    }
    if (!Array.isArray(input.availableTools)) {
      throw new AgentRuntimeError('availableTools must be an array', 'invalid_input');
    }
    if (input.resume !== undefined && input.resume !== 'post_interrupt') {
      throw new AgentRuntimeError("resume must be 'post_interrupt' when provided", 'invalid_input');
    }
    const visibleTools = new Set<string>();
    for (const tool of input.availableTools) {
      this.assertText(tool, 'availableTools entry');
      if (visibleTools.has(tool)) {
        throw new AgentRuntimeError(`availableTools contains duplicate '${tool}'`, 'invalid_input');
      }
      visibleTools.add(tool);
    }
    const tools = new Set<string>();
    for (const tool of input.allowedTools) {
      this.assertText(tool, 'allowedTools entry');
      if (tools.has(tool)) {
        throw new AgentRuntimeError(`allowedTools contains duplicate '${tool}'`, 'invalid_input');
      }
      tools.add(tool);
    }
    for (const [key, value] of Object.entries(input.env ?? {})) {
      if (key.toUpperCase() === 'HOME') {
        throw new AgentRuntimeError('HOME cannot be overridden for a headless Claude thread', 'invalid_input');
      }
      this.assertText(key, 'environment key');
      if (typeof value !== 'string' || value.includes('\0')) {
        throw new AgentRuntimeError(
          `environment value '${key}' must be a string without NUL bytes`,
          'invalid_input',
        );
      }
    }
  }

  private assertText(value: string, label: string): void {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
      throw new AgentRuntimeError(`${label} must be a non-empty string without NUL bytes`, 'invalid_input');
    }
  }

  private buildArgs(input: StartAgentThreadInput): string[] {
    return [
      ...this.commandArgs,
      '-p',
      '--verbose',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--model',
      input.model,
      '--setting-sources',
      '',
      // A curated plugin dir enables skills via the slash-command surface;
      // without one, that surface stays disabled (unchanged prior behaviour).
      ...(this.pluginDir
        ? ['--plugin-dir', this.pluginDir]
        : ['--disable-slash-commands']),
      '--mcp-config',
      input.mcpConfigPath,
      '--strict-mcp-config',
      // Chat is the human's orchestrating main thread and runs full-power,
      // full-trust Claude Code (ruled): no interactive approvals, Bash
      // unrestricted, workspace trusted.
      //
      // THIS COMMENT USED TO CLAIM the exfiltration surface on the per-thread
      // token file was "covered by secret redaction of the tm8 token shape".
      // That was FALSE AS WRITTEN and is removed rather than softened, because
      // a false safety claim in the one place a future reader will look is
      // worse than no claim. `redactSecretTokens` runs on exactly three paths
      // in this file — provider error text, stderr, and spawn-failure detail —
      // all of them ERROR paths. Assistant `text`, `thinking`, `tool_call.args`
      // and `tool_result.content` are queued raw, and the output of
      // `cat <thread>.mcp.json` is a tool_result.
      //
      // Nor would redaction be a control if it did run everywhere: it prevents
      // accidental DISPLAY. With Bash and WebFetch both present under
      // bypassPermissions, content injected through a repository file or a web
      // page exfiltrates without the bytes crossing a channel redaction
      // touches.
      //
      // What actually bounds this today: the child's environment is now an
      // allow-list (chat-env.ts), so the node's own secrets are not in the
      // process to begin with. What does NOT bound it: the `agent_runtime`
      // token in that file is a general-purpose credential for the requesting
      // human — the thread/Space/mode scope lives in the MCP client process,
      // not in the server's authorization — so a stolen token is not confined
      // by anything the server checks. Scoping it server-side off
      // `runtimeThreadRootId` (already on the row, already resolved) is the fix
      // and is deliberately NOT in this change.
      '--permission-mode',
      'bypassPermissions',
      ...(input.availableTools.length > 0
        ? ['--tools', input.availableTools.join(',')]
        : ['--disallowed-tools', ...CLAUDE_BUILTIN_TOOLS]),
      '--allowed-tools',
      ...input.allowedTools,
      input.resume === 'post_interrupt' ? '--resume' : '--session-id',
      input.nativeSessionId,
      '--system-prompt',
      input.systemPrompt,
    ];
  }

  private awaitBoot(state: ThreadState): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        state.child.off('spawn', onSpawn);
        state.child.off('error', onError);
        state.child.off('close', onClose);
      };
      const succeed = (): void => {
        cleanup();
        resolve();
      };
      const onSpawn = (): void => {
        timer = setTimeout(succeed, this.bootSettlementMs);
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(this.spawnError(error));
      };
      const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        cleanup();
        reject(
          new AgentRuntimeError(
            `Claude headless process exited during boot (${this.exitDescription(code, signal)})`,
            'spawn_failed',
          ),
        );
      };
      state.child.once('spawn', onSpawn);
      state.child.once('error', onError);
      state.child.once('close', onClose);
    });
  }

  private captureStderr(state: ThreadState, chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    state.stderr = `${state.stderr}${text}`.slice(-MAX_STDERR_CHARS);
  }

  private handleLine(state: ThreadState, line: string): void {
    if (line.trim().length === 0 || state.closed) return;
    let event: JsonObject;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isObject(parsed)) throw new Error('event is not an object');
      event = parsed;
    } catch {
      this.failActiveTurn(state, 'invalid_json', 'Claude emitted a non-JSON stream event');
      return;
    }

    const type = stringField(event, 'type');
    if (type === 'system') {
      this.handleSystemEvent(state, event);
      return;
    }
    if (type === 'assistant') {
      this.handleAssistantEvent(state, event);
      return;
    }
    if (type === 'user') {
      this.handleUserEvent(state, event);
      return;
    }
    if (type === 'result') {
      this.handleResultEvent(state, event);
    }
    // rate_limit_event and provider metadata have no C1 kind. A terminal
    // rate-limit failure is still represented by Claude's result event.
  }

  private handleSystemEvent(state: ThreadState, event: JsonObject): void {
    if (stringField(event, 'subtype') !== 'init') return;
    const observed = stringField(event, 'session_id');
    if (observed && observed !== state.input.nativeSessionId) {
      this.failActiveTurn(
        state,
        'native_session_mismatch',
        'Claude initialized a different native session than TM8 pre-minted',
      );
    }
  }

  private handleAssistantEvent(state: ThreadState, event: JsonObject): void {
    const active = state.active;
    if (!active) return;
    const message = objectField(event, 'message');
    const content = message?.['content'];
    if (!Array.isArray(content)) return;
    for (const rawBlock of content) {
      if (!isObject(rawBlock)) continue;
      const blockType = stringField(rawBlock, 'type');
      if (blockType === 'thinking') {
        const text = stringField(rawBlock, 'thinking');
        if (text !== null) active.queue.push({ kind: 'thinking', text });
      } else if (blockType === 'text') {
        const text = stringField(rawBlock, 'text');
        if (text !== null) active.queue.push({ kind: 'text', text });
      } else if (blockType === 'tool_use') {
        const id = stringField(rawBlock, 'id');
        const name = stringField(rawBlock, 'name');
        if (!id || !name) continue;
        const call: ToolCallTurnItem = {
          kind: 'tool_call',
          id,
          name,
          args: rawBlock['input'] ?? {},
          state: 'running',
        };
        active.toolCalls.set(id, call);
        active.queue.push(call);
      }
    }
  }

  private handleUserEvent(state: ThreadState, event: JsonObject): void {
    const active = state.active;
    if (!active) return;
    const message = objectField(event, 'message');
    const content = message?.['content'];
    if (!Array.isArray(content)) return;
    for (const rawBlock of content) {
      if (!isObject(rawBlock) || stringField(rawBlock, 'type') !== 'tool_result') continue;
      const toolCallId = stringField(rawBlock, 'tool_use_id');
      if (!toolCallId) continue;
      const isError = rawBlock['is_error'] === true;
      active.queue.push({
        kind: 'tool_result',
        tool_call_id: toolCallId,
        content: rawBlock['content'] ?? null,
        is_error: isError,
      });
      const running = active.toolCalls.get(toolCallId);
      if (running) {
        active.queue.push({ ...running, state: isError ? 'error' : 'completed' });
        active.toolCalls.delete(toolCallId);
      }
    }
  }

  private handleResultEvent(state: ThreadState, event: JsonObject): void {
    const active = state.active;
    if (!active) return;
    const interrupted = state.interruptRequested;
    const failed = event['is_error'] === true || stringField(event, 'subtype') !== 'success';
    if (failed && !interrupted) {
      const result = stringField(event, 'result');
      active.queue.push({
        kind: 'error',
        code: stringField(event, 'subtype') ?? 'provider_error',
        message: result && result.length > 0 ? redactSecretTokens(result) : 'Claude failed the turn',
      });
    }

    const usage = this.mapUsage(event);
    if (usage) active.queue.push(usage);
    this.finishActiveTurn(state, interrupted ? 'interrupted' : failed ? 'error' : 'success');
  }

  private mapUsage(event: JsonObject): UsageTurnItem | null {
    const modelUsage = objectField(event, 'modelUsage');
    const usage: UsageTurnItem = { kind: 'usage' };
    if (modelUsage) {
      copyModelUsageSum(modelUsage, usage, 'inputTokens', 'input_tokens');
      copyModelUsageSum(modelUsage, usage, 'outputTokens', 'output_tokens');
      copyModelUsageSum(modelUsage, usage, 'cacheCreationInputTokens', 'cache_creation_input_tokens');
      copyModelUsageSum(modelUsage, usage, 'cacheReadInputTokens', 'cache_read_input_tokens');
    }
    copyResultCost(event, usage);
    return Object.keys(usage).length > 1 ? usage : null;
  }

  private finishActiveTurn(state: ThreadState, reason: TurnDoneReason): void {
    const active = state.active;
    if (!active) return;
    active.queue.push({ kind: 'done', reason });
    active.queue.end();
    state.active = null;
  }

  private failActiveTurn(state: ThreadState, code: string, message: string): void {
    const firstFailure = !state.unusable;
    state.unusable = true;
    const active = state.active;
    if (active) {
      active.queue.push({ kind: 'error', code, message });
      this.finishActiveTurn(state, 'error');
    }
    if (firstFailure && !state.closed) state.child.kill('SIGTERM');
  }

  private handleProcessError(state: ThreadState, error: Error): void {
    this.logger?.error('Claude headless process error', error, {
      threadId: state.input.threadId,
      nativeSessionId: state.input.nativeSessionId,
    });
    if (!state.booting) {
      this.failActiveTurn(state, 'process_error', 'Claude headless process failed');
    }
  }

  private handleProcessClose(
    state: ThreadState,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (state.closed) return;
    state.closed = true;
    state.lines.close();
    this.threads.delete(state.input.threadId);

    const reason: AgentThreadExit['reason'] = state.interruptRequested
      ? 'interrupted'
      : state.closeRequested
        ? 'closed'
        : 'crashed';
    const expected = reason !== 'crashed';
    if (reason === 'interrupted') {
      this.interruptedThreads.set(state.input.threadId, {
        nativeSessionId: state.input.nativeSessionId,
        cwd: state.input.cwd,
        model: state.input.model,
      });
    }
    if (state.active) {
      if (reason === 'closed' || reason === 'interrupted') {
        this.finishActiveTurn(state, reason);
      } else {
        this.failActiveTurn(
          state,
          'process_exit',
          `Claude headless process exited (${this.exitDescription(code, signal)})`,
        );
      }
    }
    state.resolveExited();

    if (!expected) {
      const stderr = redactSecretTokens(state.stderr.trim());
      this.logger?.error('Claude headless process exited unexpectedly', undefined, {
        threadId: state.input.threadId,
        nativeSessionId: state.input.nativeSessionId,
        exitCode: code,
        signal,
        ...(stderr ? { stderr } : {}),
      });
    }
    const event: AgentThreadExit = {
      threadId: state.input.threadId,
      nativeSessionId: state.input.nativeSessionId,
      exit_code: code,
      signal,
      reason,
      expected,
    };
    try {
      const notified = this.onThreadExit?.(event);
      if (notified) {
        void notified.catch((error: unknown) => {
          this.logger?.error(
            'Claude thread-exit callback failed',
            error instanceof Error ? error : new Error(String(error)),
            { threadId: state.input.threadId },
          );
        });
      }
    } catch (error) {
      this.logger?.error(
        'Claude thread-exit callback failed',
        error instanceof Error ? error : new Error(String(error)),
        { threadId: state.input.threadId },
      );
    }
  }

  private async waitForExit(state: ThreadState, timeoutMs: number): Promise<boolean> {
    if (state.closed) return true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      void state.exited.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private spawnError(error: unknown): AgentRuntimeError {
    const detail = error instanceof Error ? error.message : String(error);
    return new AgentRuntimeError(
      `failed to start Claude headless process: ${redactSecretTokens(detail)}`,
      'spawn_failed',
    );
  }

  private exitDescription(code: number | null, signal: NodeJS.Signals | null): string {
    if (signal !== null && code !== null) return `code ${String(code)}, signal ${signal}`;
    if (signal !== null) return `signal ${signal}`;
    if (code !== null) return `code ${String(code)}`;
    return 'unknown exit status';
  }
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function objectField(object: JsonObject, key: string): JsonObject | null {
  const value = object[key];
  return isObject(value) ? value : null;
}

function stringField(object: JsonObject, key: string): string | null {
  const value = object[key];
  return typeof value === 'string' ? value : null;
}

function copyModelUsageSum(
  models: JsonObject,
  target: UsageTurnItem,
  sourceKey:
    | 'inputTokens'
    | 'outputTokens'
    | 'cacheCreationInputTokens'
    | 'cacheReadInputTokens',
  targetKey:
    | 'input_tokens'
    | 'output_tokens'
    | 'cache_creation_input_tokens'
    | 'cache_read_input_tokens',
): void {
  let reported = false;
  let total = 0;
  for (const raw of Object.values(models)) {
    if (!isObject(raw)) continue;
    const value = raw[sourceKey];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    reported = true;
    total += value;
  }
  if (reported) Object.assign(target, { [targetKey]: total });
}

function copyResultCost(result: JsonObject, target: UsageTurnItem): void {
  const value = result['total_cost_usd'];
  if (typeof value === 'number' && Number.isFinite(value)) {
    target.total_cost_usd = value;
  }
}
