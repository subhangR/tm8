import type { ChatCredentialSelection, EntityId } from './contract.js';
import { launchModel, type LaunchModelEffort } from './launch-models.js';

/** Credential provider differs from the catalog's inference vendor for Kimi. */
export type ChatCredentialProvider = 'anthropic' | 'openai' | 'kimi' | 'groq';

export interface ChatCredentialIntent {
  defaultChoice: Pick<ChatCredentialSelection, 'source'>;
  byProvider: Partial<Record<ChatCredentialProvider, ChatCredentialSelection>>;
}

export function chatCredentialProviderForModel(model: string): ChatCredentialProvider | null {
  const entry = launchModel(model);
  if (!entry) return null;
  return entry.provider === 'moonshot' ? 'kimi' : entry.provider;
}

/** This projects intent only. A failed grant never falls back through this helper. */
export function chatCredentialChoice(
  intent: ChatCredentialIntent, provider: ChatCredentialProvider,
): ChatCredentialSelection {
  return intent.byProvider[provider] ?? intent.defaultChoice;
}

export function withChatCredentialChoice(
  intent: ChatCredentialIntent, provider: ChatCredentialProvider,
  choice: ChatCredentialSelection,
): ChatCredentialIntent {
  const byProvider = { ...intent.byProvider };
  byProvider[provider] = { ...choice };
  if (choice.credentialId) {
    return { defaultChoice: { ...intent.defaultChoice }, byProvider };
  }
  return { defaultChoice: { source: choice.source }, byProvider };
}

export interface ChatCredentialDisplay {
  provider: ChatCredentialProvider;
  source: 'member' | 'space' | 'node';
  /** Present only when the viewer may discover this credential. */
  credentialId?: EntityId;
  label?: string;
  resolutionReason: 'personal_default' | 'member' | 'space_default' | 'node' | 'pinned';
}

/** Public evidence only: no native IDs, paths, account material or launch handles. */
export interface ChatRuntimeState {
  schemaVersion: 1;
  configRevision: number;
  activeTurn: {
    turnId: EntityId;
    configRevision: number;
    generation: number | null;
    model: string;
    provider: string;
    agentTool: string;
    reasoningEffort: LaunchModelEffort | null;
    status: 'preparing' | 'running' | 'cancelling' | 'interrupted' | 'failed';
    credential?: ChatCredentialDisplay;
  } | null;
  runtime: {
    generation: number | null;
    phase: 'starting' | 'ready' | 'running' | 'stopping' | 'stopped' | 'failed' | 'unknown';
    continuity: 'native_verified' | 'portable_verified' | 'pending' | 'unavailable';
    observedAt: string | null;
  };
  pendingForNextClaim: boolean;
}
