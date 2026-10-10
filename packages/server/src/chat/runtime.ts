import type { ChatTurnUsage, SessionTranscriptContext } from '@tm8/contract';
import type { ChatMode, ChatCredentialSelection } from '@tm8/contract';

/** Legacy shim; execution owns the runtime contract. */
export type { TurnItem } from '@tm8/execution';
import type { TurnItem } from '@tm8/execution';

export interface StartAgentThreadInput {
  readonly threadId: string;
  readonly nativeSessionId: string;
  readonly model: string;
  readonly cwd: string;
  readonly systemPrompt: string;
  readonly mcpConfigPath: string;
  /** Provider-native tools visible to the model. */
  readonly availableTools: readonly string[];
  /** Provider-native and MCP calls pre-approved for this immutable mode. */
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
  readonly availableTools: readonly string[];
  readonly allowedTools: readonly string[];
  /** Thread-owned checkout, when the Space has exactly one linked project. */
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface ChatLaunchConfigInput {
  /** 176: the chat entity. Was `rootMessageId` while a chat was a message. */
  readonly chatId: string;
  readonly credentialSelection?: ChatCredentialSelection;
  /** Preflight checks access without rewriting any live credential home. */
  readonly credentialValidationOnly?: boolean;
  /** Human whose current turn authorizes this runtime token. */
  readonly requesterIdentityId: string;
  /**
   * R9 truthful replay: the SERVER-RESOLVED tm8.auth_kind recorded by
   * Server-resolved auth kind captured when this human queued the turn. Null
   * means the resolver omits the claim and the C5 mint fails closed.
   */
  readonly requesterAuthKind: string | null;
  readonly teammateId: string;
  readonly model: string;
  readonly provider: string;
  readonly agentTool: string;
  readonly chatMode: ChatMode;
  readonly spaceId: string;
  readonly cwd: string;
  readonly mode: 'new' | 'resume-after-interrupt';
}

export type ResolveChatLaunchConfig = (
  input: ChatLaunchConfigInput,
) => Promise<ChatLaunchConfig>;

/** Rechecked before every turn, separately from the cold-start MCP token mint. */
export type ResolveChatCredentialEnv = (
  input: ChatLaunchConfigInput,
) => Promise<Readonly<Record<string, string>>>;
