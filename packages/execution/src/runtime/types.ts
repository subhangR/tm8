// @tm8/execution — provider-neutral chat runtime contracts.
//
// This surface is intentionally independent of PtyHostService. A chat thread
// owns a structured, pipe-driven vendor process; a work session owns a PTY.
// Making either pretend to be the other would fill the interface with methods
// that cannot be implemented honestly.

/** The lifecycle states carried by every tool-call update (TM8 Chat C1). */
export type ToolCallState = 'running' | 'completed' | 'error';

export interface ThinkingTurnItem {
  kind: 'thinking';
  text: string;
}

export interface TextTurnItem {
  kind: 'text';
  text: string;
}

/**
 * Tool calls are append-only updates. A runtime first emits `running`, then a
 * second item with the same id and `completed|error` when its result arrives.
 */
export interface ToolCallTurnItem {
  kind: 'tool_call';
  id: string;
  name: string;
  args: unknown;
  state: ToolCallState;
}

export interface ToolResultTurnItem {
  kind: 'tool_result';
  tool_call_id: string;
  content: unknown;
  is_error: boolean;
}

/**
 * Per-turn token and cost facts from the provider.
 *
 * Every field is optional because an omitted provider fact is unknown. In
 * particular `total_cost_usd` MUST remain absent when Claude omits it; filling
 * it with zero would turn "not reported" into a false billing record.
 */
export interface UsageTurnItem {
  kind: 'usage';
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  total_cost_usd?: number;
}

export interface ErrorTurnItem {
  kind: 'error';
  code: string;
  message: string;
}

export type TurnDoneReason = 'success' | 'error' | 'interrupted' | 'closed';

export interface DoneTurnItem {
  kind: 'done';
  reason: TurnDoneReason;
}

/** The exact seven-kind union pinned by TM8 Chat contract C1. */
export type TurnItem =
  | ThinkingTurnItem
  | TextTurnItem
  | ToolCallTurnItem
  | ToolResultTurnItem
  | UsageTurnItem
  | ErrorTurnItem
  | DoneTurnItem;

export interface StartAgentThreadInput {
  /** Durable TM8 message-thread root id; the registry is keyed by this value. */
  threadId: string;
  /** TM8-minted UUID passed as `--session-id`, or `--resume` for R8. */
  nativeSessionId: string;
  model: string;
  /** Absolute and immutable for the thread: Claude transcripts are cwd-keyed. */
  cwd: string;
  systemPrompt: string;
  /** Absolute path to the per-thread strict MCP configuration. */
  mcpConfigPath: string;
  /** Closed, pre-authorized TM8 MCP tool set. */
  allowedTools: readonly string[];
  /**
   * Narrow D8/R8 exception authorized by the orchestrator's durable thread
   * binding after an interrupt. There is no general v1 resume mode and the
   * runtime never respawns eagerly.
   */
  resume?: 'post_interrupt';
  /**
   * Per-thread additions such as CLAUDE_CONFIG_DIR or MCP auth material.
   * HOME is expressly forbidden: Claude subscription auth uses the keychain.
   */
  env?: Readonly<Record<string, string>>;
}

export interface AgentThread {
  threadId: string;
  nativeSessionId: string;
}

export interface AgentTurnInput {
  text: string;
}

export interface AgentThreadExit {
  threadId: string;
  nativeSessionId: string;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  reason: 'closed' | 'interrupted' | 'crashed';
  expected: boolean;
}

/**
 * Small port shared by current and future structured agent providers.
 *
 * `sendTurn` returns immediately with a single-consumer stream. Provider and
 * process failures are represented inside that stream as `error` + `done`;
 * programmer/lifecycle errors (unknown thread, overlapping turn) throw before
 * a stream is returned.
 */
export interface AgentRuntime {
  startThread(input: StartAgentThreadInput): Promise<AgentThread>;
  sendTurn(threadId: string, input: AgentTurnInput): AsyncIterable<TurnItem>;
  /**
   * `true` means the runtime accepted delivery of its interrupt signal. Turn
   * completion is proved only by the stream's terminal `done` item.
   */
  interrupt(threadId: string): Promise<boolean>;
  close(threadId: string): Promise<void>;
}

export class AgentRuntimeError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid_input'
      | 'thread_exists'
      | 'thread_not_found'
      | 'turn_in_progress'
      | 'thread_closing'
      | 'resume_required'
      | 'resume_mismatch'
      | 'spawn_failed'
      | 'close_failed',
  ) {
    super(message);
    this.name = 'AgentRuntimeError';
  }
}
