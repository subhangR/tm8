import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { boundedLines } from './BoundedLines.js';
import { composeChatEnv } from './chat-env.js';
import { harnessFailure } from './HarnessRegistry.js';
import { HarnessSessionBase, validateLaunch } from './HarnessSessionBase.js';
import {
  CODEX_PROTOCOL_REVISION,
  count,
  object,
  string,
  turn,
  type WireObject,
} from './codex-protocol.js';
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
  UsageFact,
} from './harness-types.js';

const CAPABILITIES: HarnessCapabilities = {
  schemaVersion: 1,
  harness: 'codex',
  binaryVersion: '0.161.0',
  protocolRevision: CODEX_PROTOCOL_REVISION,
  nativeResume: 'supported',
  portableBootstrap: 'supported',
  cancelActiveTurn: 'supported',
  nativeTurnIds: 'supported',
  usage: 'supported',
  contextReading: 'supported',
  interactiveRequests: 'unsupported',
  textInputs: 'supported',
  imageInputs: 'unsupported',
  fileInputs: 'unsupported',
  builtInToolRestriction: 'unknown',
  configuration: {
    model: 'per_turn',
    reasoningEffort: 'per_turn',
    serviceTier: 'per_turn',
    instructions: 'restart',
    tools: 'restart',
    credential: 'restart',
  },
};
export interface CodexAppServerAdapterOptions {
  nodeId: string;
  rpcTimeoutMs?: number;
  closeGraceMs?: number;
}
export class CodexAppServerAdapter implements HarnessAdapter {
  readonly kind = 'codex' as const;
  constructor(private readonly options: CodexAppServerAdapterOptions) {}
  async capabilities(): Promise<HarnessCapabilities> {
    return structuredClone(CAPABILITIES);
  }
  async open(input: OpenHarnessInput): Promise<CodexSession> {
    validateLaunch(input, this.kind, this.options.nodeId);
    let session: CodexSession | undefined;
    try {
      const material = await input.launch.materialize();
      if (material.harness !== this.kind || !material.modelConfigDir || !material.cwd)
        throw harnessFailure('invalid_config', 'open', 'Codex launch material is invalid');
      session = new CodexSession(input, material, this.options);
      await session.initialize();
      return session;
    } catch (error) {
      if (session) await session.close('failure');
      else await input.launch.release();
      throw error;
    }
  }
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
class CodexSession extends HarnessSessionBase {
  opened!: OpenReceipt;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private requestSeq = 0;
  private nativeId: string | null = null;
  private exited = false;
  private exitResolve!: () => void;
  private readonly exitPromise = new Promise<void>((resolve) => {
    this.exitResolve = resolve;
  });
  private closePromise: Promise<CloseReceipt> | null = null;
  private dispatching = false;
  private cancelPending = false;
  private released: Promise<void> | null = null;
  private readonly retiredTurns = new Set<string>();
  private readonly textRevisions = new Map<string, number>();
  private readonly completedItems = new Set<string>();
  private totals: UsageFact | null;
  private attemptBaseline: UsageFact | null = null;
  private readonly usageSeen = new Set<string>();
  private configuredModel: string | null = null;
  constructor(
    input: OpenHarnessInput,
    private readonly material: LaunchMaterial,
    private readonly options: CodexAppServerAdapterOptions,
  ) {
    super(input);
    this.totals =
      input.usageBaseline?.scope === 'native_conversation'
        ? structuredClone(input.usageBaseline)
        : input.mode.kind === 'resume'
          ? null
          : zeroUsage();
    this.child = spawn(material.command, [...material.argvPrefix, 'app-server'], {
      cwd: material.cwd,
      env: { ...composeChatEnv(process.env), ...material.env, CODEX_HOME: material.modelConfigDir },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    // Install listeners before handshake; idle exits are observations too.
    const lines = boundedLines(
      this.child.stdout,
      (line) => {
        try {
          this.receive(object(JSON.parse(line)));
        } catch {
          this.protocolLost('Invalid Codex protocol frame');
        }
      },
      () => this.protocolLost('Codex protocol frame exceeded its bound'),
    );
    // Diagnostics are intentionally drained without carrying vendor/secret text to public errors.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', () => this.protocolLost('Codex stdin became unavailable'));
    this.child.on('error', () => this.protocolLost('Codex process could not start'));
    this.child.on('close', (code, signal) => {
      this.exited = true;
      this.dead = true;
      lines.close();
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(
          harnessFailure(
            'runtime_lost',
            'stream',
            'Codex process exited',
            'reconcile_before_retry',
          ),
        );
      }
      this.pending.clear();
      if (this.active) this.terminal('runtime_lost', 'process_exit');
      this.emit({ kind: 'runtime_exit', expected: this.closing, exitCode: code, signal }, true);
      this.finishEvents();
      this.exitResolve();
      // release is chained by close, or independently after an idle death.
      if (!this.closePromise) void this.release().catch(() => {});
    });
  }
  async initialize(): Promise<void> {
    const hello = object(
      await this.rpc('initialize', {
        clientInfo: { name: 'tm8-chat', title: 'tm8 chat', version: '1' },
        capabilities: null,
      }),
    );
    if (
      typeof hello['userAgent'] !== 'string' ||
      !/(?:^|\D)0\.161\.0(?:\D|$)/.test(hello['userAgent'])
    )
      throw harnessFailure('protocol_mismatch', 'open', 'Codex app-server version must be 0.161.0');
    this.write({ method: 'initialized' });
    const config = object(structuredClone(this.material.providerConfig ?? {}));
    const target = this.input.config.target;
    if (
      target.reasoningEffort !== null &&
      !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(target.reasoningEffort)
    )
      throw harnessFailure(
        'unsupported_capability',
        'open',
        'Codex reasoning effort is unsupported',
      );
    if (target.provider !== 'openai' && !object(config['model_providers'] ?? {})[target.provider])
      throw harnessFailure(
        'unsupported_capability',
        'open',
        'Codex backend lacks explicit provider settings',
      );
    // Groq has no provider-side stateful history. The pinned HTTP path sends
    // full local history; websocket continuation can send previous_response_id.
    if (target.provider === 'groq') {
      const providers = object(config['model_providers']);
      config['model_providers'] = {
        ...providers,
        groq: { ...object(providers['groq']), supports_websockets: false },
      };
    }
    const mcp = Object.fromEntries(
      this.material.mcpServers.map((server) => {
        if (!/^[A-Za-z0-9_-]+$/.test(server.name))
          throw harnessFailure('invalid_config', 'open', 'Invalid MCP server name');
        return [
          server.name,
          {
            command: server.command,
            args: [...server.args],
            env: { ...server.env },
            ...(server.cwd ? { cwd: server.cwd } : {}),
          },
        ];
      }),
    );
    // Composition supplies isolated settings. Explicit MCP map prevents Claude-file passthrough.
    const settings = {
      ...config,
      mcp_servers: mcp,
      ...(target.reasoningEffort ? { model_reasoning_effort: target.reasoningEffort } : {}),
    };
    const bootstrap = this.input.mode.kind === 'bootstrap' ? this.input.mode.context : null;
    const instructions = [this.material.instructionText, bootstrap?.renderedContext]
      .filter(Boolean)
      .join('\n\n');
    const params = {
      model: target.model,
      modelProvider: target.provider,
      serviceTier: target.serviceTier,
      cwd: this.material.cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      config: settings,
      developerInstructions: instructions,
      ephemeral: false,
    };
    const resume = this.input.mode.kind === 'resume' ? this.input.mode : null;
    let response: WireObject;
    try {
      response = object(
        await this.rpc(
          resume ? 'thread/resume' : 'thread/start',
          resume ? { ...params, threadId: resume.native.nativeId } : params,
        ),
      );
    } catch (error) {
      if (resume)
        throw harnessFailure(
          'continuity_required',
          'open',
          'Codex native transcript could not be resumed',
          'resume_or_bootstrap',
        );
      throw error;
    }
    const nativeId = string(object(response['thread'])['id']);
    if (resume && nativeId !== resume.native.nativeId)
      throw harnessFailure(
        'continuity_required',
        'open',
        'Codex returned a different native conversation',
        'resume_or_bootstrap',
      );
    this.nativeId = nativeId;
    this.configuredModel = typeof response['model'] === 'string' ? response['model'] : null;
    const native = {
      schemaVersion: 1 as const,
      harness: 'codex' as const,
      nativeId,
      nodeId: this.options.nodeId,
      storageScopeId: this.input.launch.nativeStorageScopeId,
      nativeStorageGeneration: this.input.launch.nativeStorageGeneration,
      cwdIdentity: this.input.config.cwdIdentity,
      historyFormat: CODEX_PROTOCOL_REVISION,
    };
    this.opened = {
      native,
      nativeConfirmed: true,
      readiness: 'protocol_session_ack',
      capabilities: structuredClone(CAPABILITIES),
      execution: {
        requested: target,
        configuredModel: this.configuredModel,
        observedModel: null,
        observedEffort: null,
        observedServiceTier: null,
        evidence: 'protocol_echo',
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
    this.emit({ kind: 'native_confirmed', native });
  }
  async submit(command: TurnCommand): Promise<DispatchReceipt> {
    if (this.dispatching)
      throw harnessFailure('invalid_config', 'submit', 'A dispatch acknowledgement is pending');
    if (
      command.config.target.reasoningEffort !== null &&
      !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(
        command.config.target.reasoningEffort,
      )
    )
      throw harnessFailure(
        'unsupported_capability',
        'submit',
        'Codex reasoning effort is unsupported',
      );
    this.reserve(command);
    this.cancelPending = false;
    if (this.configuredModel !== command.config.target.model) {
      this.configuredModel = command.config.target.model;
      this.emit({
        kind: 'context',
        context: {
          usedTokens: null,
          capacityTokens: null,
          cacheReadTokens: null,
          requestInputTokens: null,
          model: this.configuredModel,
          observedAt: new Date().toISOString(),
          source: 'codex_request_usage',
          capacitySource: null,
          unavailableReason: 'awaiting_new_sample',
        },
      });
    }
    this.emit({
      kind: 'execution_facts',
      facts: {
        requested: command.config.target,
        configuredModel: this.configuredModel,
        observedModel: null,
        observedEffort: null,
        observedServiceTier: null,
        evidence: 'requested_only',
      },
    });
    this.dispatching = true;
    this.attemptBaseline = this.totals;
    this.textRevisions.clear();
    this.completedItems.clear();
    this.usageSeen.clear();
    const attempt = this.active!;
    try {
      const response = object(
        await this.rpc('turn/start', {
          threadId: this.nativeId,
          input: [{ type: 'text', text: command.text, text_elements: [] }],
          clientUserMessageId: command.clientSubmissionId,
          model: command.config.target.model,
          effort: command.config.target.reasoningEffort,
          serviceTier: command.config.target.serviceTier,
        }),
      );
      const nativeTurn = turn(response['turn']);
      if (this.isActive(attempt)) this.acceptTurn(nativeTurn.id);
      // A terminal notification may precede this response. Acknowledgement is still delivery, never completion.
      return { delivery: 'sent', acknowledgement: 'native_ack', nativeTurnId: nativeTurn.id };
    } catch {
      return { delivery: 'unknown', nativeTurnId: this.nativeTurnId };
    } finally {
      this.dispatching = false;
    }
  }
  async cancel(attempt: AttemptRef): Promise<CancelReceipt> {
    if (this.isTerminal(attempt)) return { disposition: 'already_terminal', nativeTurnId: null };
    if (!this.isActive(attempt)) return { disposition: 'not_running', nativeTurnId: null };
    const id = this.nativeTurnId;
    if (!id) {
      this.cancelPending = true;
      return { disposition: 'requested', nativeTurnId: null };
    }
    try {
      await this.rpc('turn/interrupt', { threadId: this.nativeId, turnId: id });
      return { disposition: 'requested', nativeTurnId: id };
    } catch {
      return { disposition: 'failed', nativeTurnId: id };
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
      let forced = false;
      if (!this.exited) {
        this.child.stdin.end();
        const timer = setTimeout(() => {
          forced = true;
          this.child.kill('SIGKILL');
        }, this.options.closeGraceMs ?? 1000);
        await this.exitPromise;
        clearTimeout(timer);
      }
      let cleanup: 'complete' | 'pending' = 'complete';
      try { await this.release(); }
      catch { cleanup = 'pending'; }
      return { exited: true, forced, nativeUsable: null, cleanup };
    })();
    return this.closePromise;
  }
  private release(): Promise<void> {
    this.released ??= this.input.launch.release();
    return this.released;
  }
  protected abortTransport(): void {
    this.child.kill('SIGKILL');
  }
  private write(frame: WireObject): void {
    if (this.dead || !this.child.stdin.writable)
      throw harnessFailure(
        'runtime_lost',
        'stream',
        'Codex stdin is unavailable',
        'reconcile_before_retry',
      );
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }
  private rpc(method: string, params: WireObject): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.dead) {
        reject(
          harnessFailure(
            'runtime_lost',
            'stream',
            'Codex process is unavailable',
            'reconcile_before_retry',
          ),
        );
        return;
      }
      const id = ++this.requestSeq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          harnessFailure(
            'runtime_lost',
            'stream',
            'Codex protocol acknowledgement timed out',
            'reconcile_before_retry',
          ),
        );
        this.protocolLost('Codex protocol acknowledgement timed out');
      }, this.options.rpcTimeoutMs ?? 10_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  private receive(frame: WireObject): void {
    if (frame['id'] !== undefined && typeof frame['method'] !== 'string') {
      const pending = this.pending.get(frame['id'] as number);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(frame['id'] as number);
      if (frame['error'])
        pending.reject(
          harnessFailure(
            'provider_error',
            'stream',
            'Codex rejected the protocol request',
            'reconcile_before_retry',
          ),
        );
      else pending.resolve(frame['result']);
      return;
    }
    const method = string(frame['method']),
      data = object(frame['params'] ?? {});
    if (frame['id'] !== undefined) {
      this.denyRequest(frame, method);
      return;
    }
    if (data['threadId'] !== undefined && this.nativeId && data['threadId'] !== this.nativeId)
      return;
    const eventTurnId =
      typeof data['turnId'] === 'string'
        ? data['turnId']
        : method === 'turn/started' || method === 'turn/completed'
          ? string(object(data['turn'])['id'])
          : null;
    if (eventTurnId && this.retiredTurns.has(eventTurnId)) return;
    if (method === 'turn/started' && this.active) {
      this.acceptTurn(turn(data['turn']).id);
      return;
    }
    if (
      !this.active ||
      (typeof data['turnId'] === 'string' &&
        this.nativeTurnId &&
        data['turnId'] !== this.nativeTurnId)
    )
      return;
    if (method === 'turn/completed') {
      const completed = turn(data['turn']);
      if (this.nativeTurnId && completed.id !== this.nativeTurnId) return;
      this.acceptTurn(completed.id);
      for (const item of completed.items) this.item(object(item), true);
      if (completed.status === 'inProgress')
        throw harnessFailure(
          'protocol_error',
          'stream',
          'Nonterminal turn/completed status',
          'reconcile_before_retry',
        );
      this.retiredTurns.add(completed.id);
      this.terminal(
        completed.status === 'completed'
          ? 'completed'
          : completed.status === 'interrupted'
            ? 'interrupted'
            : 'failed',
        'provider_terminal',
      );
      return;
    }
    if (typeof data['turnId'] === 'string') this.acceptTurn(data['turnId']);
    if (method === 'item/agentMessage/delta') {
      const id = string(data['itemId']);
      if (this.completedItems.has(id)) return;
      if (typeof data['delta'] !== 'string') throw new Error('invalid delta');
      this.emit({
        kind: 'text',
        itemId: id,
        revision: this.revision(id),
        operation: 'append',
        text: data['delta'],
        phase: 'unknown',
      });
    } else if (method === 'item/started' || method === 'item/completed')
      this.item(object(data['item']), method === 'item/completed');
    else if (method === 'item/reasoning/summaryTextDelta')
      this.emit({
        kind: 'thinking',
        itemId: string(data['itemId']),
        text: typeof data['delta'] === 'string' ? data['delta'] : '',
      });
    else if (method === 'thread/tokenUsage/updated') this.usage(data);
    else if (method === 'error')
      this.emit({
        kind: 'failure',
        failure: harnessFailure(
          'provider_error',
          'stream',
          'Codex reported an inference error',
          'reconcile_before_retry',
        ).failure,
        willRetry: data['willRetry'] === true,
      });
    else if (method === 'model/rerouted') {
      this.configuredModel =
        typeof data['toModel'] === 'string' ? data['toModel'] : this.configuredModel;
      this.emit({
        kind: 'execution_facts',
        facts: {
          ...this.opened.execution,
          observedModel: typeof data['toModel'] === 'string' ? data['toModel'] : null,
          evidence: 'provider_observed',
        },
      });
      this.emit({
        kind: 'context',
        context: {
          usedTokens: null,
          capacityTokens: null,
          cacheReadTokens: null,
          requestInputTokens: null,
          model: this.configuredModel,
          observedAt: new Date().toISOString(),
          source: 'codex_request_usage',
          capacitySource: null,
          unavailableReason: 'awaiting_new_sample',
        },
      });
    }
  }
  private acceptTurn(id: string): void {
    if (!this.active) return;
    if (this.nativeTurnId) {
      if (this.nativeTurnId !== id) throw new Error('conflicting turn id');
      return;
    }
    this.nativeTurnId = id;
    this.emit({ kind: 'turn_accepted', nativeTurnId: id });
    if (this.cancelPending) {
      this.cancelPending = false;
      void this.rpc('turn/interrupt', { threadId: this.nativeId, turnId: id }).catch(() => {});
    }
    if (this.opened.seed)
      this.emit({
        kind: 'seed_acknowledged',
        seed: { ...this.opened.seed, acknowledgement: 'turn_accepted' },
      });
  }
  private revision(id: string): number {
    const value = (this.textRevisions.get(id) ?? 0) + 1;
    this.textRevisions.set(id, value);
    return value;
  }
  private item(item: WireObject, completed: boolean): void {
    const id = string(item['id']),
      type = string(item['type']);
    if (completed && this.completedItems.has(id)) return;
    if (completed) this.completedItems.add(id);
    if (type === 'agentMessage') {
      if (!completed) return;
      if (typeof item['text'] !== 'string') throw new Error('invalid text');
      this.emit({
        kind: 'text',
        itemId: id,
        revision: this.revision(id),
        operation: 'replace',
        text: item['text'],
        phase:
          item['phase'] === 'final_answer'
            ? 'final'
            : item['phase'] === 'commentary'
              ? 'commentary'
              : 'unknown',
      });
      return;
    }
    if (type === 'contextCompaction') {
      this.emit({
        kind: 'context',
        context: {
          usedTokens: null,
          capacityTokens: null,
          cacheReadTokens: null,
          requestInputTokens: null,
          model: this.configuredModel,
          observedAt: new Date().toISOString(),
          source: 'codex_request_usage',
          capacitySource: null,
          unavailableReason: 'awaiting_new_sample',
        },
      });
      return;
    }
    if (!['commandExecution', 'mcpToolCall', 'fileChange'].includes(type)) return;
    const existing = this.tools.get(id),
      status = item['status'];
    const state = !completed
      ? 'running'
      : status === 'failed'
        ? 'failed'
        : status === 'declined'
          ? 'declined'
          : status === 'completed'
            ? 'completed'
            : 'unresolved';
    this.tool({
      toolKey: this.toolKey(id),
      nativeCallId: id,
      name:
        type === 'mcpToolCall'
          ? `${string(item['server'])}.${string(item['tool'])}`
          : type === 'commandExecution'
            ? 'Bash'
            : 'fileChange',
      args: (type === 'mcpToolCall'
        ? (item['arguments'] ?? null)
        : type === 'commandExecution'
          ? { command: item['command'] ?? null }
          : { changes: item['changes'] ?? null }) as Json,
      state,
      result: (type === 'mcpToolCall'
        ? (item['result'] ?? item['error'] ?? null)
        : type === 'commandExecution'
          ? { output: item['aggregatedOutput'] ?? null, exitCode: item['exitCode'] ?? null }
          : null) as Json,
      origin: type === 'mcpToolCall' ? 'mcp' : 'native',
      evidence: completed ? (existing ? 'completed' : 'completion_only') : 'started',
    });
  }
  private usage(data: WireObject): void {
    const sample = object(data['tokenUsage']),
      total = object(sample['total']),
      last = object(sample['last']);
    const observationId = `${this.nativeTurnId}/${JSON.stringify(total)}`;
    if (this.usageSeen.has(observationId)) return;
    this.usageSeen.add(observationId);
    const current: UsageFact = {
      scope: 'native_conversation',
      observationId,
      requestId: null,
      inputTokens: count(total['inputTokens']),
      outputTokens: count(total['outputTokens']),
      cacheReadTokens: count(total['cachedInputTokens']),
      cacheWriteTokens: count(total['cacheWriteInputTokens']),
      reasoningOutputTokens: count(total['reasoningOutputTokens']),
      costUsd: null,
      costBasis: 'unknown',
      evidence: 'reported',
      baselineId: null,
    };
    this.emit({ kind: 'usage', usage: current });
    if (this.attemptBaseline) {
      const delta = (
        key:
          | 'inputTokens'
          | 'outputTokens'
          | 'cacheReadTokens'
          | 'cacheWriteTokens'
          | 'reasoningOutputTokens',
      ) => {
        const now = current[key],
          before = this.attemptBaseline![key];
        return now !== null && before !== null && now >= before ? now - before : null;
      };
      this.emit({
        kind: 'usage',
        usage: {
          ...current,
          scope: 'attempt',
          observationId: `${observationId}/delta`,
          inputTokens: delta('inputTokens'),
          outputTokens: delta('outputTokens'),
          cacheReadTokens: delta('cacheReadTokens'),
          cacheWriteTokens: delta('cacheWriteTokens'),
          reasoningOutputTokens: delta('reasoningOutputTokens'),
          evidence: 'cumulative_difference',
          baselineId: this.attemptBaseline.observationId,
        },
      });
    }
    this.totals = current;
    const input = count(last['inputTokens']),
      capacity = count(sample['modelContextWindow']);
    this.emit({
      kind: 'context',
      context: {
        usedTokens: input,
        capacityTokens: capacity,
        cacheReadTokens: count(last['cachedInputTokens']),
        requestInputTokens: input,
        model: this.configuredModel,
        observedAt: new Date().toISOString(),
        source: 'codex_request_usage',
        capacitySource: capacity === null ? null : 'provider',
        unavailableReason: input === null ? 'incomplete_usage' : null,
      },
    });
  }
  private denyRequest(frame: WireObject, method: string): void {
    const id = frame['id'];
    let result: WireObject | null = null;
    if (
      method === 'item/commandExecution/requestApproval' ||
      method === 'item/fileChange/requestApproval'
    )
      result = { decision: 'decline' };
    else if (method === 'item/permissions/requestApproval')
      result = { permissions: {}, scope: 'turn', strictAutoReview: true };
    else if (method === 'item/tool/requestUserInput') result = { answers: {} };
    else if (method === 'mcpServer/elicitation/request')
      result = { action: 'decline', content: null, _meta: null };
    this.write(
      result
        ? { id, result }
        : { id, error: { code: -32601, message: 'Unsupported interactive request' } },
    );
    this.emit({
      kind: 'warning',
      code: 'unsupported_request',
      safeMessage: 'An unsupported harness request was declined',
    });
  }
  private protocolLost(message: string): void {
    if (this.dead) return;
    this.dead = true;
    this.emit(
      {
        kind: 'failure',
        failure: harnessFailure('runtime_lost', 'stream', message, 'reconcile_before_retry')
          .failure,
        willRetry: false,
      },
      true,
    );
    this.terminal('runtime_lost', 'reconciliation');
    this.abortTransport();
  }
}
function zeroUsage(): UsageFact {
  return {
    scope: 'native_conversation',
    observationId: 'fresh',
    requestId: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningOutputTokens: 0,
    costUsd: null,
    costBasis: 'unknown',
    evidence: 'reported',
    baselineId: null,
  };
}
