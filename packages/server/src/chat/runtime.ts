import type { ChatTurnUsage } from '@tm8/contract';

/**
 * C1 runtime port. This intentionally mirrors packages/execution's chat lane
 * without importing its concrete adapters, so the server can be composed and
 * tested before the provider-specific branch is merged.
 */
export type TurnItem =
  | { readonly kind: 'thinking'; readonly text: string }
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'tool_call';
      readonly id: string;
      readonly name: string;
      readonly args: unknown;
      readonly state: 'running' | 'completed' | 'error';
    }
  | {
      readonly kind: 'tool_result';
      readonly tool_call_id: string;
      readonly content: unknown;
      readonly is_error: boolean;
    }
  | ({ readonly kind: 'usage' } & ChatTurnUsage)
  | { readonly kind: 'error'; readonly code: string; readonly message: string }
  | { readonly kind: 'done'; readonly reason: 'success' | 'error' | 'interrupted' | 'closed' };

export interface StartAgentThreadInput {
  readonly threadId: string;
  readonly nativeSessionId: string;
  readonly model: string;
  readonly cwd: string;
  readonly systemPrompt: string;
  readonly mcpConfigPath: string;
  readonly allowedTools: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** R8: the one v1 resume path, used lazily after an interrupted turn. */
  readonly resume?: {
    readonly nativeSessionId: string;
    readonly cwd: string;
  };
}

export interface AgentThread {
  readonly threadId: string;
}

export interface AgentRuntime {
  startThread(input: StartAgentThreadInput): Promise<AgentThread>;
  sendTurn(threadId: string, input: { readonly text: string }): AsyncIterable<TurnItem>;
  interrupt(threadId: string): Promise<boolean>;
  close(threadId: string): Promise<void>;
}

export interface ChatLaunchConfig {
  readonly systemPrompt: string;
  readonly mcpConfigPath: string;
  readonly allowedTools: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface ChatLaunchConfigInput {
  readonly rootMessageId: string;
  readonly requesterIdentityId: string;
  readonly teammateId: string;
  readonly model: string;
  readonly provider: string;
  readonly agentTool: string;
  readonly mode: 'new' | 'resume-after-interrupt';
}

export type ResolveChatLaunchConfig = (
  input: ChatLaunchConfigInput,
) => Promise<ChatLaunchConfig>;
