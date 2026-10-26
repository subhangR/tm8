// Private, execution-owned chat harness port. Vendor processes report evidence;
// the server owns authorization, canonical history, recovery and persistence.

export type HarnessKind = 'claude' | 'codex';
export type Json = null | boolean | number | string | readonly Json[]
  | { readonly [key: string]: Json };
export type Support = 'supported' | 'unsupported' | 'unknown';

export interface HarnessTarget {
  readonly harness: HarnessKind;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: string | null;
  readonly serviceTier: string | null;
}

export interface HarnessCapabilities {
  readonly schemaVersion: 1;
  readonly harness: HarnessKind;
  readonly binaryVersion: string;
  readonly protocolRevision: string;
  readonly nativeResume: Support;
  readonly portableBootstrap: Support;
  readonly cancelActiveTurn: Support;
  readonly nativeTurnIds: Support;
  readonly usage: Support;
  readonly contextReading: Support;
  readonly interactiveRequests: Support;
  readonly textInputs: Support;
  readonly imageInputs: Support;
  readonly fileInputs: Support;
  readonly builtInToolRestriction: Support;
  readonly configuration: Readonly<Record<
    'model' | 'reasoningEffort' | 'serviceTier' | 'instructions' | 'tools' | 'credential',
    'per_turn' | 'restart' | 'unsupported' | 'unknown'
  >>;
}

export interface NativeConversationRef {
  readonly schemaVersion: 1;
  readonly harness: HarnessKind;
  readonly nativeId: string;
  readonly nodeId: string;
  readonly storageScopeId: string; // opaque node-local history namespace
  readonly nativeStorageGeneration: number;
  readonly cwdIdentity: string;   // canonical, immutable directory identity
  readonly historyFormat: string;
}

export interface GenerationFence {
  readonly chatId: string;
  readonly bindingId: string;
  readonly generation: number;
  readonly leaseEpoch: number;
  readonly configRevision: number;
}

export interface AttemptRef {
  readonly turnId: string;       // stable tm8 user-request identity
  readonly attemptId: string;   // distinct dispatch/recovery attempt
  readonly configRevision: number; // frozen attempt config, may differ from launch
}

export interface RuntimeConfig {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly target: HarnessTarget;
  readonly instructionHash: string;
  readonly toolPolicyHash: string;
  readonly mcpBindingRevision: string;
  readonly cwdIdentity: string;
  readonly credentialBindingId: string;
  readonly credentialRevision: string | null;
  readonly launchFingerprint: string | null; // nonsecret comparison token
}

export interface CoverageCursor {
  readonly throughTurnOrdinal: number;
  readonly captureHighWater: number;
  readonly projectionPolicyVersion: string;
  readonly authorityScopeDigest: string;
  readonly logicalHistoryDigest: string;
}

export interface BootstrapContext {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly coverage: CoverageCursor;
  readonly contentHash: string;
  readonly renderedContext: string;
  readonly manifest: readonly {
    readonly sourceId: string;
    readonly treatment: 'included' | 'summarized' | 'reference';
    readonly reason: string | null;
  }[];
}

export type OpenMode =
  | { readonly kind: 'create' }
  | {
      readonly kind: 'resume';
      readonly native: NativeConversationRef;
      readonly expectedCoverage: CoverageCursor;
    }
  | { readonly kind: 'bootstrap'; readonly context: BootstrapContext };

export interface McpDescriptor {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string | null;
}

export interface LaunchMaterial {
  readonly harness: HarnessKind;
  readonly command: string;
  readonly argvPrefix: readonly string[];
  readonly cwd: string;
  readonly modelConfigDir: string;
  readonly env: Readonly<Record<string, string>>;
  readonly instructionText: string;
  readonly providerConfig: Json;
  readonly mcpConfigPath: string;
  readonly mcpServers: readonly McpDescriptor[];
  readonly nativeTools: readonly string[];
  readonly allowedTools: readonly string[];
}

export interface PreparedLaunch {
  readonly kind: 'ephemeral-launch';
  readonly launchId: string;
  readonly storageScopeId: string;
  /** Native history namespace may differ from the private credential/config root. */
  readonly nativeStorageScopeId: string;
  readonly nativeStorageGeneration: number;
  readonly owner: {
    readonly chatId: string;
    readonly generation: number;
    readonly ownerLeaseId: string;
    readonly claimFence: string;
  };
  readonly modelCredentialLeaseId: string;
  readonly runtimeGrantId: string;
  readonly capabilityPlanId: string;
  // Node-local materialization. Never serialize this object, env, or auth files.
  materialize(): Promise<LaunchMaterial>;
  // Release only this generation's files and credential lease after exit.
  release(): Promise<void>;
}

export interface OpenHarnessInput {
  readonly fence: GenerationFence;
  readonly config: RuntimeConfig;
  readonly mode: OpenMode;
  readonly launch: PreparedLaunch;
  /** Verified cumulative counters for this native conversation, if available. */
  readonly usageBaseline?: UsageFact;
}

export interface ExecutionFacts {
  readonly requested: HarnessTarget;
  readonly configuredModel: string | null;
  readonly observedModel: string | null;
  readonly observedEffort: string | null;
  readonly observedServiceTier: string | null;
  readonly evidence: 'requested_only' | 'protocol_echo' | 'provider_observed';
}

export interface OpenReceipt {
  readonly native: NativeConversationRef;
  readonly nativeConfirmed: boolean;
  readonly readiness: 'stdin_writable' | 'protocol_session_ack';
  readonly capabilities: HarnessCapabilities;
  readonly execution: ExecutionFacts;
  readonly seed: SeedReceipt | null;
}

export interface SeedReceipt {
  readonly snapshotId: string;
  readonly coverage: CoverageCursor;
  readonly contentHash: string;
  readonly transport: 'instructions' | 'current_turn_prefix';
  readonly acknowledgement: 'launch_materialized' | 'protocol_echo' | 'turn_accepted';
}

export interface TurnCommand {
  readonly attempt: AttemptRef;
  readonly clientSubmissionId: string;
  readonly text: string; // current user input plus server-authored attribution
  readonly attachmentRefs: readonly string[];
  readonly config: RuntimeConfig; // frozen attempt config; supports safe turn overrides
}

export type DispatchReceipt =
  | { readonly delivery: 'not_sent'; readonly code: string }
  | {
      readonly delivery: 'sent';
      readonly acknowledgement: 'local_write' | 'native_ack';
      readonly nativeTurnId: string | null;
    }
  | { readonly delivery: 'unknown'; readonly nativeTurnId: string | null };

export interface CancelReceipt {
  readonly disposition: 'requested' | 'already_terminal' | 'not_running' | 'failed';
  readonly nativeTurnId: string | null;
}

export interface RuntimeFailure {
  readonly code:
    | 'invalid_config' | 'unsupported_capability' | 'continuity_required'
    | 'credential_unavailable' | 'spawn_failed' | 'protocol_mismatch'
    | 'protocol_error' | 'provider_error' | 'runtime_lost' | 'persistence_failed';
  readonly stage: 'prepare' | 'open' | 'submit' | 'stream' | 'cancel' | 'close';
  readonly safeMessage: string;
  readonly providerCode: string | null;
  readonly disposition: 'retry_before_dispatch' | 'resume_or_bootstrap'
    | 'reconcile_before_retry' | 'blocked';
}

export interface UsageFact {
  readonly scope: 'request' | 'attempt' | 'native_conversation';
  readonly observationId: string;
  readonly requestId: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly reasoningOutputTokens: number | null;
  readonly costUsd: number | null;
  readonly costBasis: 'provider_reported' | 'client_estimate' | 'unknown';
  readonly evidence: 'reported' | 'cumulative_difference';
  readonly baselineId: string | null;
}

export interface ContextFact {
  readonly usedTokens: number | null;
  readonly capacityTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly requestInputTokens: number | null;
  readonly model: string | null;
  readonly observedAt: string;
  readonly source: 'claude_request_usage' | 'codex_request_usage';
  readonly capacitySource: 'provider' | 'runtime' | null;
  readonly unavailableReason: 'not_reported' | 'incomplete_usage'
    | 'sample_outside_window' | 'awaiting_new_sample' | null;
}

export interface ToolObservation {
  readonly toolKey: string; // scoped generation + attempt + native item/call ID
  readonly nativeCallId: string;
  readonly name: string;
  readonly args: Json | null;
  readonly state: 'running' | 'completed' | 'failed' | 'declined' | 'unresolved';
  readonly result: Json | null;
  readonly origin: 'native' | 'mcp';
  readonly evidence: 'started' | 'completed' | 'completion_only' | 'runtime_lost';
}

export interface PendingHarnessRequest {
  readonly requestKey: string; // scopes vendor RPC ID to this connection/generation
  readonly nativeRequestId: string | number;
  readonly kind: 'approval' | 'user_input' | 'elicitation' | 'dynamic_tool';
  readonly itemId: string | null;
  readonly payload: Json;
  readonly deadlineAt: string;
}

export type TerminalOutcome = 'completed' | 'failed' | 'interrupted' | 'runtime_lost';
export type ObservationPayload =
  | { readonly kind: 'native_confirmed'; readonly native: NativeConversationRef }
  | { readonly kind: 'seed_acknowledged'; readonly seed: SeedReceipt }
  | { readonly kind: 'turn_accepted'; readonly nativeTurnId: string | null }
  | {
      readonly kind: 'text'; readonly itemId: string; readonly revision: number;
      readonly operation: 'append' | 'replace'; readonly text: string;
      readonly phase: 'commentary' | 'final' | 'unknown';
    }
  | { readonly kind: 'thinking'; readonly itemId: string; readonly text: string }
  | { readonly kind: 'tool'; readonly tool: ToolObservation }
  | { readonly kind: 'request'; readonly request: PendingHarnessRequest }
  | { readonly kind: 'request_resolved'; readonly requestKey: string }
  | { readonly kind: 'usage'; readonly usage: UsageFact }
  | { readonly kind: 'context'; readonly context: ContextFact }
  | { readonly kind: 'execution_facts'; readonly facts: ExecutionFacts }
  | { readonly kind: 'warning'; readonly code: string; readonly safeMessage: string }
  | { readonly kind: 'failure'; readonly failure: RuntimeFailure; readonly willRetry: boolean }
  | {
      readonly kind: 'terminal'; readonly outcome: TerminalOutcome;
      readonly evidence: 'provider_terminal' | 'process_exit' | 'reconciliation';
    }
  | {
      readonly kind: 'runtime_exit'; readonly expected: boolean;
      readonly exitCode: number | null; readonly signal: string | null;
    };

export interface HarnessObservation {
  readonly schemaVersion: 1;
  readonly fence: GenerationFence;
  readonly attempt: AttemptRef | null; // idle failures are still observable
  readonly nativeTurnId: string | null;
  readonly adapterSeq: number; // monotonic within a generation, assigned once
  readonly observedAt: string;
  readonly payload: ObservationPayload;
}

export interface CloseReceipt {
  readonly exited: boolean;
  readonly forced: boolean;
  readonly nativeUsable: boolean | null;
  // Process exit is independent of owned-resource cleanup. A missing field
  // proves nothing about cleanup; the launch owner may retry its exact release.
  readonly cleanup?: 'complete' | 'pending';
}

export interface HarnessSession {
  readonly fence: GenerationFence;
  readonly opened: OpenReceipt;
  // Single consumer, buffered from spawn; covers both active and idle events.
  readonly observations: AsyncIterable<HarnessObservation>;
  submit(command: TurnCommand): Promise<DispatchReceipt>;
  cancel(attempt: AttemptRef, reason: 'user' | 'revocation' | 'shutdown'): Promise<CancelReceipt>;
  respond(requestKey: string, response: Json): Promise<void>;
  close(reason: 'reconfigure' | 'shutdown' | 'revocation' | 'failure'): Promise<CloseReceipt>;
}

export interface HarnessAdapter {
  readonly kind: HarnessKind;
  capabilities(): Promise<HarnessCapabilities>;
  open(input: OpenHarnessInput): Promise<HarnessSession>;
}

export type BindingState = 'dormant' | 'starting' | 'ready' | 'busy'
  | 'cancelling' | 'closing' | 'stopped' | 'failed' | 'lost';
export type AttemptState = 'prepared' | 'dispatching' | 'running' | 'waiting'
  | 'cancelling' | 'completed' | 'failed' | 'interrupted' | 'runtime_lost';

export interface RuntimeBinding extends GenerationFence {
  readonly schemaVersion: 1;
  readonly stateVersion: number;
  readonly state: BindingState;
  readonly ownerNodeId: string;
  readonly leaseExpiresAt: string;
  readonly config: RuntimeConfig;
  readonly native: NativeConversationRef | null;
  readonly nativeConfirmed: boolean;
  readonly nativeCoverage: CoverageCursor | null;
  readonly readiness: OpenReceipt['readiness'] | null;
  readonly activeAttempt: AttemptRef | null;
  readonly lastAdapterSeq: number;
}
