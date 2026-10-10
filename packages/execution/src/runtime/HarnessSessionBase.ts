import { harnessFailure } from './HarnessRegistry.js';
import type {
  AttemptRef,
  HarnessObservation,
  HarnessSession,
  OpenHarnessInput,
  OpenReceipt,
  ObservationPayload,
  ToolObservation,
  TurnCommand,
  TerminalOutcome,
} from './harness-types.js';

/** Single consumer, bounded backlog. Overflow makes the generation uncertain. */
class ObservationQueue implements AsyncIterable<HarnessObservation> {
  private items: HarnessObservation[] = [];
  private bytes = 0;
  private waiting: ((value: IteratorResult<HarnessObservation>) => void) | null = null;
  private ended = false;
  private consumed = false;
  push(value: HarnessObservation, critical = false): boolean {
    if (this.ended) return false;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ done: false, value });
      return true;
    }
    const size = JSON.stringify(value).length;
    if (!critical && (this.items.length >= 4096 || this.bytes + size > 8_388_608)) return false;
    this.items.push(value);
    this.bytes += size;
    return true;
  }
  end(): void {
    this.ended = true;
    if (this.waiting) {
      this.waiting({ done: true, value: undefined });
      this.waiting = null;
    }
  }
  [Symbol.asyncIterator](): AsyncIterator<HarnessObservation> {
    if (this.consumed) throw new Error('Harness observations have one consumer');
    this.consumed = true;
    return {
      next: async () => {
        const value = this.items.shift();
        if (value) {
          this.bytes -= JSON.stringify(value).length;
          return { done: false, value };
        }
        if (this.ended) return { done: true, value: undefined };
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

export abstract class HarnessSessionBase implements HarnessSession {
  readonly fence;
  readonly observations: AsyncIterable<HarnessObservation>;
  abstract opened: OpenReceipt;
  protected readonly input: OpenHarnessInput;
  protected active: AttemptRef | null = null;
  protected nativeTurnId: string | null = null;
  protected readonly tools = new Map<string, ToolObservation>();
  protected dead = false;
  protected closing = false;
  private readonly queue = new ObservationQueue();
  private seq = 0;
  private readonly submitted = new Set<string>();
  private lastTerminal: string | null = null;
  constructor(input: OpenHarnessInput) {
    // Copy caller-owned values; the opaque launch stays node-local.
    this.input = {
      ...input,
      fence: structuredClone(input.fence),
      config: structuredClone(input.config),
      mode: structuredClone(input.mode),
    };
    this.fence = Object.freeze({ ...input.fence });
    this.observations = this.queue;
  }
  protected reserve(command: TurnCommand): void {
    if (this.dead || this.closing)
      throw harnessFailure(
        'runtime_lost',
        'submit',
        'Harness generation is unavailable',
        'resume_or_bootstrap',
      );
    if (this.active)
      throw harnessFailure('invalid_config', 'submit', 'A harness attempt is already active');
    if (this.submitted.has(command.attempt.attemptId))
      throw harnessFailure('invalid_config', 'submit', 'Attempt was already dispatched');
    if (!command.text.trim() || command.attachmentRefs.length)
      throw harnessFailure(
        'unsupported_capability',
        'submit',
        'Only nonempty text input is supported',
      );
    if (command.attempt.configRevision !== command.config.revision)
      throw harnessFailure('invalid_config', 'submit', 'Attempt config revision does not match');
    const a = this.input.config,
      b = command.config;
    const unchanged = a.revision === b.revision;
    const sameSurface =
      a.target.harness === b.target.harness &&
      a.target.provider === b.target.provider &&
      a.cwdIdentity === b.cwdIdentity &&
      a.instructionHash === b.instructionHash &&
      a.toolPolicyHash === b.toolPolicyHash &&
      a.mcpBindingRevision === b.mcpBindingRevision &&
      a.credentialBindingId === b.credentialBindingId &&
      a.credentialRevision === b.credentialRevision &&
      a.launchFingerprint === b.launchFingerprint;
    if (!sameSurface || (!unchanged && (!a.credentialRevision || !a.launchFingerprint)))
      throw harnessFailure(
        'continuity_required',
        'submit',
        'Launch compatibility requires a new generation',
        'resume_or_bootstrap',
      );
    for (const [key, feature] of [
      ['model', 'model'],
      ['reasoningEffort', 'reasoningEffort'],
      ['serviceTier', 'serviceTier'],
    ] as const) {
      if (
        a.target[key] !== b.target[key] &&
        this.opened.capabilities.configuration[feature] !== 'per_turn'
      )
        throw harnessFailure(
          'continuity_required',
          'submit',
          `${feature} change requires a new generation`,
          'resume_or_bootstrap',
        );
    }
    this.active = Object.freeze({ ...command.attempt });
    this.nativeTurnId = null;
    this.tools.clear();
    this.submitted.add(command.attempt.attemptId);
  }
  protected emit(payload: ObservationPayload, critical = false): void {
    const event: HarnessObservation = {
      schemaVersion: 1,
      fence: this.fence,
      attempt: this.active,
      nativeTurnId: this.nativeTurnId,
      adapterSeq: ++this.seq,
      observedAt: new Date().toISOString(),
      payload,
    };
    if (!this.queue.push(event, critical) && !this.dead) {
      this.dead = true;
      this.emit(
        {
          kind: 'failure',
          failure: harnessFailure(
            'runtime_lost',
            'stream',
            'Harness observation backlog exceeded its bound',
            'reconcile_before_retry',
          ).failure,
          willRetry: false,
        },
        true,
      );
      this.terminal('runtime_lost', 'reconciliation');
      this.abortTransport();
    }
  }
  protected tool(tool: ToolObservation): void {
    const previous = this.tools.get(tool.nativeCallId);
    if (previous && JSON.stringify(previous) === JSON.stringify(tool)) return;
    this.tools.set(tool.nativeCallId, tool);
    this.emit({ kind: 'tool', tool });
  }
  protected toolKey(id: string): string {
    return `${this.fence.bindingId}/${this.fence.generation}/${this.active?.attemptId ?? 'idle'}/${id}`;
  }
  protected terminal(
    outcome: TerminalOutcome,
    evidence: 'provider_terminal' | 'process_exit' | 'reconciliation',
  ): void {
    if (!this.active) return;
    for (const tool of this.tools.values())
      if (tool.state === 'running')
        this.tool({ ...tool, state: 'unresolved', evidence: 'runtime_lost' });
    this.emit({ kind: 'terminal', outcome, evidence }, true);
    this.lastTerminal = this.active.attemptId;
    this.active = null;
    this.nativeTurnId = null;
  }
  protected isTerminal(attempt: AttemptRef): boolean {
    return this.lastTerminal === attempt.attemptId;
  }
  protected isActive(attempt: AttemptRef): boolean {
    return (
      this.active?.attemptId === attempt.attemptId &&
      this.active.turnId === attempt.turnId &&
      this.active.configRevision === attempt.configRevision
    );
  }
  protected finishEvents(): void {
    this.queue.end();
  }
  protected abstract abortTransport(): void;
  abstract submit(command: TurnCommand): ReturnType<HarnessSession['submit']>;
  abstract cancel(
    ...args: Parameters<HarnessSession['cancel']>
  ): ReturnType<HarnessSession['cancel']>;
  abstract respond(
    ...args: Parameters<HarnessSession['respond']>
  ): ReturnType<HarnessSession['respond']>;
  abstract close(...args: Parameters<HarnessSession['close']>): ReturnType<HarnessSession['close']>;
}

export function validateLaunch(
  input: OpenHarnessInput,
  harness: 'claude' | 'codex',
  nodeId: string,
): void {
  if (
    input.config.target.harness !== harness ||
    input.fence.configRevision !== input.config.revision ||
    input.launch.owner.chatId !== input.fence.chatId ||
    input.launch.owner.generation !== input.fence.generation
  )
    throw harnessFailure('invalid_config', 'open', 'Launch ownership or config fence mismatch');
  if (input.mode.kind === 'resume') {
    const native = input.mode.native;
    if (
      native.harness !== harness ||
      native.nodeId !== nodeId ||
      native.cwdIdentity !== input.config.cwdIdentity ||
      native.storageScopeId !== input.launch.nativeStorageScopeId ||
      native.nativeStorageGeneration !== input.launch.nativeStorageGeneration
    )
      throw harnessFailure(
        'continuity_required',
        'open',
        'Native transcript scope is incompatible',
        'resume_or_bootstrap',
      );
  }
}
