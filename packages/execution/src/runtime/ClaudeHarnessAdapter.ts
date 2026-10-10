import { randomUUID } from 'node:crypto';
import { ClaudeHeadlessAdapter } from './ClaudeHeadlessAdapter.js';
import { AgentRuntimeError, type TurnItem } from './types.js';
import { HarnessSessionBase, validateLaunch } from './HarnessSessionBase.js';
import { harnessFailure } from './HarnessRegistry.js';
import type {
  AttemptRef,
  CancelReceipt,
  CloseReceipt,
  DispatchReceipt,
  HarnessAdapter,
  HarnessCapabilities,
  Json,
  LaunchMaterial,
  OpenHarnessInput,
  OpenReceipt,
  TurnCommand,
} from './harness-types.js';

const CAPABILITIES: HarnessCapabilities = {
  schemaVersion: 1,
  harness: 'claude',
  binaryVersion: 'structured-cli',
  protocolRevision: 'claude-stream-json/v1',
  nativeResume: 'supported',
  portableBootstrap: 'supported',
  cancelActiveTurn: 'supported',
  nativeTurnIds: 'unsupported',
  usage: 'supported',
  contextReading: 'supported',
  interactiveRequests: 'unsupported',
  textInputs: 'supported',
  imageInputs: 'unsupported',
  fileInputs: 'unsupported',
  builtInToolRestriction: 'supported',
  configuration: {
    model: 'restart',
    reasoningEffort: 'restart',
    serviceTier: 'unsupported',
    instructions: 'restart',
    tools: 'restart',
    credential: 'restart',
  },
};
export interface ClaudeHarnessAdapterOptions {
  nodeId: string;
  bootSettlementMs?: number;
  closeGraceMs?: number;
  pluginDir?: string;
}
export class ClaudeHarnessAdapter implements HarnessAdapter {
  readonly kind = 'claude' as const;
  constructor(private readonly options: ClaudeHarnessAdapterOptions) {}
  async capabilities(): Promise<HarnessCapabilities> {
    return structuredClone(CAPABILITIES);
  }
  async open(input: OpenHarnessInput): Promise<ClaudeSession> {
    validateLaunch(input, this.kind, this.options.nodeId);
    if (input.config.target.serviceTier !== null)
      throw harnessFailure('unsupported_capability', 'open', 'Claude service tier is unsupported');
    if (
      input.config.target.reasoningEffort !== null &&
      !['low', 'medium', 'high', 'max'].includes(input.config.target.reasoningEffort)
    )
      throw harnessFailure(
        'unsupported_capability',
        'open',
        'Claude reasoning effort is unsupported',
      );
    let session: ClaudeSession | undefined;
    try {
      const material = await input.launch.materialize();
      if (material.harness !== 'claude')
        throw harnessFailure('invalid_config', 'open', 'Claude launch material is invalid');
      if (input.config.target.provider !== 'anthropic' && !material.env['ANTHROPIC_BASE_URL'])
        throw harnessFailure(
          'unsupported_capability',
          'open',
          'Claude backend requires an explicit provider route',
        );
      session = new ClaudeSession(input, material, this.options);
      await session.initialize();
      return session;
    } catch (error) {
      if (session) await session.close('failure');
      else await input.launch.release();
      if (error instanceof AgentRuntimeError)
        throw harnessFailure(
          error.code === 'continuity_required' ? 'continuity_required' : 'spawn_failed',
          'open',
          error.code === 'continuity_required'
            ? 'Claude native transcript is unavailable'
            : 'Claude process could not open',
          error.code === 'continuity_required' ? 'resume_or_bootstrap' : 'retry_before_dispatch',
        );
      throw error;
    }
  }
}
class ClaudeSession extends HarnessSessionBase {
  opened: OpenReceipt;
  private readonly runtime: ClaudeHeadlessAdapter;
  private readonly key: string;
  private dispatchResolve: ((value: DispatchReceipt) => void) | null = null;
  private pump: Promise<void> | null = null;
  private started = false;
  private closePromise: Promise<CloseReceipt> | null = null;
  private exitSeen = false;
  private forced = false;
  private seedAcknowledged = false;
  private acceptedAttempt: string | null = null;
  private released: Promise<void> | null = null;
  constructor(
    input: OpenHarnessInput,
    private readonly material: LaunchMaterial,
    options: ClaudeHarnessAdapterOptions,
  ) {
    super(input);
    this.key = `${input.fence.bindingId}/${input.fence.generation}/${input.fence.leaseEpoch}`;
    const native = {
      schemaVersion: 1 as const,
      harness: 'claude' as const,
      nativeId: input.mode.kind === 'resume' ? input.mode.native.nativeId : randomUUID(),
      nodeId: options.nodeId,
      storageScopeId: input.launch.nativeStorageScopeId,
      nativeStorageGeneration: input.launch.nativeStorageGeneration,
      cwdIdentity: input.config.cwdIdentity,
      historyFormat: 'claude-stream-json/v1',
    };
    const bootstrap = input.mode.kind === 'bootstrap' ? input.mode.context : null;
    this.opened = {
      native,
      nativeConfirmed: false,
      readiness: 'stdin_writable',
      capabilities: structuredClone(CAPABILITIES),
      execution: {
        requested: input.config.target,
        configuredModel: input.config.target.model,
        observedModel: null,
        observedEffort: null,
        observedServiceTier: null,
        evidence: 'requested_only',
      },
      seed: bootstrap
        ? {
            snapshotId: bootstrap.snapshotId,
            coverage: bootstrap.coverage,
            contentHash: bootstrap.contentHash,
            transport: 'instructions',
            acknowledgement: 'launch_materialized',
          }
        : null,
    };
    this.runtime = new ClaudeHeadlessAdapter({
      command: material.command,
      commandArgs: material.argvPrefix,
      env: process.env,
      bootSettlementMs: options.bootSettlementMs,
      closeGraceMs: options.closeGraceMs,
      pluginDir: options.pluginDir,
      normalizedEvidence: true,
      onNativeConfirmed: () => {
        this.opened = { ...this.opened, nativeConfirmed: true };
        this.emit({ kind: 'native_confirmed', native });
        if (this.active && this.acceptedAttempt !== this.active.attemptId) {
          this.acceptedAttempt = this.active.attemptId;
          this.emit({ kind: 'turn_accepted', nativeTurnId: null });
        }
        if (this.opened.seed && !this.seedAcknowledged) {
          this.seedAcknowledged = true;
          this.emit({
            kind: 'seed_acknowledged',
            seed: { ...this.opened.seed, acknowledgement: 'protocol_echo' },
          });
        }
      },
      onTurnDispatched: (error) => {
        this.dispatchResolve?.(
          error
            ? { delivery: 'unknown', nativeTurnId: null }
            : { delivery: 'sent', acknowledgement: 'local_write', nativeTurnId: null },
        );
        this.dispatchResolve = null;
      },
      onThreadExit: async (event) => {
        this.dead = true;
        this.exitSeen = true;
        this.forced = event.signal === 'SIGKILL' || event.signal === 'SIGTERM';
        this.dispatchResolve?.({ delivery: 'unknown', nativeTurnId: null });
        this.dispatchResolve = null;
        await this.pump;
        this.terminal('runtime_lost', 'process_exit');
        this.emit(
          {
            kind: 'runtime_exit',
            expected: event.expected,
            exitCode: event.exit_code,
            signal: event.signal,
          },
          true,
        );
        this.finishEvents();
        await this.release();
      },
    });
  }
  async initialize(): Promise<void> {
    const target = this.input.config.target;
    this.started = true;
    await this.runtime.startThread({
      threadId: this.key,
      nativeSessionId: this.opened.native.nativeId,
      model: target.model,
      cwd: this.material.cwd,
      systemPrompt: [
        this.material.instructionText,
        this.input.mode.kind === 'bootstrap' ? this.input.mode.context.renderedContext : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      mcpConfigPath: this.material.mcpConfigPath,
      availableTools: this.material.nativeTools,
      allowedTools: this.material.allowedTools,
      ...(target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}),
      ...(this.input.mode.kind === 'resume' ? { resume: 'post_interrupt' as const } : {}),
      env: { ...this.material.env, CLAUDE_CONFIG_DIR: this.material.modelConfigDir },
    });
  }
  async submit(command: TurnCommand): Promise<DispatchReceipt> {
    this.reserve(command);
    const receipt = new Promise<DispatchReceipt>((resolve) => {
      this.dispatchResolve = resolve;
    });
    try {
      const stream = this.runtime.sendTurn(this.key, { text: command.text });
      this.pump = this.consume(stream);
      return await receipt;
    } catch {
      this.dispatchResolve = null;
      this.emit({
        kind: 'failure',
        failure: harnessFailure(
          'runtime_lost',
          'submit',
          'Claude could not accept the turn',
          'resume_or_bootstrap',
        ).failure,
        willRetry: false,
      });
      this.terminal('runtime_lost', 'reconciliation');
      return { delivery: 'not_sent', code: 'stdin_unavailable' };
    }
  }
  private async consume(stream: AsyncIterable<TurnItem>): Promise<void> {
    let textSeq = 0;
    for await (const item of stream) {
      if (!this.active) continue;
      if (item.kind === 'text')
        this.emit({
          kind: 'text',
          itemId: item.itemId ?? `text-${++textSeq}`,
          revision: item.revision ?? 1,
          operation: item.operation ?? 'append',
          text: item.text,
          phase: 'unknown',
        });
      else if (item.kind === 'thinking')
        this.emit({ kind: 'thinking', itemId: `thinking-${++textSeq}`, text: item.text });
      else if (item.kind === 'tool_call') {
        const previous = this.tools.get(item.id);
        // A following result supplies terminal truth; don't erase its payload with a redundant call update.
        if (previous && previous.state !== 'running' && item.state !== 'running') continue;
        this.tool({
          toolKey: this.toolKey(item.id),
          nativeCallId: item.id,
          name: item.name,
          args: item.args as Json,
          state: item.state === 'error' ? 'failed' : item.state,
          result: previous?.result ?? null,
          origin: item.name.startsWith('mcp__') ? 'mcp' : 'native',
          evidence: item.state === 'running' ? 'started' : 'completed',
        });
      } else if (item.kind === 'tool_result') {
        const previous = this.tools.get(item.tool_call_id);
        this.tool({
          toolKey: this.toolKey(item.tool_call_id),
          nativeCallId: item.tool_call_id,
          name: previous?.name ?? 'unknown',
          args: previous?.args ?? null,
          state: item.is_error ? 'failed' : 'completed',
          result: item.content as Json,
          origin: previous?.origin ?? 'native',
          evidence: previous ? 'completed' : 'completion_only',
        });
      } else if (item.kind === 'usage')
        this.emit({
          kind: 'usage',
          usage: {
            scope: 'attempt',
            observationId: `${this.active.attemptId}/result`,
            requestId: null,
            inputTokens: item.input_tokens ?? null,
            outputTokens: item.output_tokens ?? null,
            cacheReadTokens: item.cache_read_input_tokens ?? null,
            cacheWriteTokens: item.cache_creation_input_tokens ?? null,
            reasoningOutputTokens: null,
            costUsd: item.total_cost_usd ?? null,
            costBasis: item.total_cost_usd === undefined ? 'unknown' : 'provider_reported',
            evidence: 'reported',
            baselineId: null,
          },
        });
      else if (item.kind === 'context')
        this.emit({
          kind: 'context',
          context: {
            ...item.context,
            source: item.context.source ?? 'claude_request_usage',
            observedAt: item.context.observedAt ?? new Date().toISOString(),
          },
        });
      else if (item.kind === 'error')
        this.emit({
          kind: 'failure',
          failure: harnessFailure(
            'provider_error',
            'stream',
            'Claude reported a turn error',
            'reconcile_before_retry',
          ).failure,
          willRetry: false,
        });
      else if (item.kind === 'done')
        this.terminal(
          item.evidence === 'provider_terminal'
            ? item.reason === 'success'
              ? 'completed'
              : item.reason === 'interrupted'
                ? 'interrupted'
                : 'failed'
            : 'runtime_lost',
          item.evidence ?? 'reconciliation',
        );
    }
  }
  async cancel(attempt: AttemptRef): Promise<CancelReceipt> {
    if (this.isTerminal(attempt)) return { disposition: 'already_terminal', nativeTurnId: null };
    if (!this.isActive(attempt)) return { disposition: 'not_running', nativeTurnId: null };
    try {
      return {
        disposition: (await this.runtime.interrupt(this.key)) ? 'requested' : 'failed',
        nativeTurnId: null,
      };
    } catch {
      return { disposition: 'failed', nativeTurnId: null };
    }
  }
  async respond(): Promise<void> {
    throw harnessFailure(
      'unsupported_capability',
      'stream',
      'Interactive harness requests are unsupported',
    );
  }
  close(_reason: 'reconfigure' | 'shutdown' | 'revocation' | 'failure'): Promise<CloseReceipt> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      if (this.started && !this.exitSeen) await this.runtime.close(this.key);
      await this.pump;
      let cleanup: 'complete' | 'pending' = 'complete';
      try { await this.release(); }
      catch { cleanup = 'pending'; }
      return { exited: true, forced: this.forced, nativeUsable: null, cleanup };
    })();
    return this.closePromise;
  }
  private release(): Promise<void> {
    this.released ??= this.input.launch.release();
    return this.released;
  }
  protected abortTransport(): void {
    void this.runtime.close(this.key);
  }
}
