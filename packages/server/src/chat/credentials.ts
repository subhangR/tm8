import {
  CREDENTIAL_PROVIDERS,
  agentCredentialProviderFor,
  apiKeyBackendForModel,
  SpawnError,
  applyAgentCredentialEnv,
  materializeSpaceApiKeyHome,
  resolveMemberCredentialHome,
  resolveSessionCredentials,
  type AgentCredentialHomePort,
  type AgentCredentialHome,
  type ResolvedLaunchConfig,
  type SpaceCredentialPort,
} from '@tm8/execution';
import { launchModel } from '@tm8/contract';
import { join } from 'node:path';
import type { Db, DbClaims } from '../db/types.js';
import { DbAgentCredentialHome } from '../credentials/agent-credential-injection.js';
import { spaceCredentialPort } from '../credentials/space-credential-port.js';
import type { ChatLaunchConfigInput, ResolveChatCredentialEnv } from './runtime.js';

/** Chat uses the same model credential ladder and policy gate as a fresh session. */
export interface ChatCredentialResolverOptions {
  db: Db;
  dataDir: string;
  memberCredentials?: AgentCredentialHomePort;
  spaceCredentials?: SpaceCredentialPort;
  parentEnv?: NodeJS.ProcessEnv;
}

export interface ChatCredentialRoute {
  readonly model: string;
  readonly agentTool: 'claude-code' | 'codex';
  readonly harness: 'claude' | 'codex';
  readonly nativeProvider: 'anthropic' | 'openai';
  readonly inferenceProvider: 'anthropic' | 'openai' | 'kimi' | 'groq';
  readonly policyProvider: 'anthropic' | 'openai';
  readonly catalogProvider: string;
}

/** Provider authority is the admitted catalog, never the request's provider text. */
export function chatCredentialRoute(input: { model: string; agentTool: string }): ChatCredentialRoute {
  const entry = launchModel(input.model);
  const native = agentCredentialProviderFor(input.agentTool);
  if (!entry || entry.agentTool !== input.agentTool || (native !== 'anthropic' && native !== 'openai')) {
    throw new SpawnError('The selected model and chat harness are not an admitted combination', 'invalid_input');
  }
  return {
    model: entry.model, agentTool: entry.agentTool,
    harness: entry.agentTool === 'codex' ? 'codex' : 'claude',
    nativeProvider: native, policyProvider: native,
    inferenceProvider: apiKeyBackendForModel(entry.agentTool, entry.model) ?? native,
    catalogProvider: entry.provider,
  };
}

export interface ChatCredentialBinding {
  readonly route: ChatCredentialRoute;
  readonly source: 'member' | 'space' | 'node';
  readonly credentialId: string | null;
  readonly requesterIdentityId: string;
  readonly requesterAuthKind: string | null;
  readonly spaceId: string;
  /** These readers do not yet prove vendor account/material revisions. */
  readonly accountGeneration: null;
  readonly materialRevision: null;
  readonly hotReuse: false;
}

/** Node-private selection. Only `binding` may be persisted/projected. */
export interface ResolvedChatCredential {
  readonly binding: ChatCredentialBinding;
  readonly credentialHome: AgentCredentialHome | null;
  readonly env: Readonly<Record<string, string>>;
}

/** Shared policy resolution without token mint, refresh or filesystem writes. */
export function createChatCredentialResolver(options: ChatCredentialResolverOptions) {
  const member = options.memberCredentials ?? new DbAgentCredentialHome(options);
  const space = options.spaceCredentials ?? spaceCredentialPort(options.db, options.dataDir);
  return async (input: ChatLaunchConfigInput): Promise<ResolvedChatCredential> => {
    const auth: DbClaims = {
      identityId: input.requesterIdentityId,
      ...(input.requesterAuthKind ? { authKind: input.requesterAuthKind } : {}),
    };
    const selection = input.credentialSelection ?? { source: 'auto' };
    const route = chatCredentialRoute(input);
    const provider = route.nativeProvider;
    if (selection.source === 'node' && apiKeyBackendForModel(input.agentTool, input.model)) {
      throw new SpawnError('This model requires your own connected provider key; server credentials cannot serve it', 'invalid_input');
    }
    const source = selection.source === 'auto' ? null : selection.source;
    const launch: ResolvedLaunchConfig = {
      mode: 'worker', model: input.model, agentTool: input.agentTool,
      permissionMode: 'bypassPermissions', accessMode: 'fullAccess', reasoningEffort: null,
      credentialSource: null,
      credentialSources: Object.fromEntries(CREDENTIAL_PROVIDERS.map(p => [p, p === provider ? source : null])) as ResolvedLaunchConfig['credentialSources'],
      ...(selection.credentialId ? { spaceCredentialIds: { [provider]: selection.credentialId } } : {}),
    };
    const resolved = await resolveSessionCredentials({
      auth, spaceId: input.spaceId, launch, modelOnly: true,
      linkBound: auth.authKind === 'link',
    }, {
      spaceCredentials: space,
      resolveMemberHome: source => resolveMemberCredentialHome(member, auth, input.agentTool, input.model, source),
      resolveMemberGitHub: async () => null,
      materializeApiKeyHome: async grant => {
        const homeDir = join(options.dataDir, 'credentials', 'sessions', input.chatId);
        return { provider: grant.provider, homeDir, configDir: join(homeDir, grant.provider),
          space: { credentialId: grant.credentialId, apiKey: grant.apiKey } };
      },
    });
    // Match session precedence, with no other ambient secrets copied into chat.
    const env: Record<string, string> = {};
    const nodeKeyVar = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
    const nodeKey = (options.parentEnv ?? process.env)[nodeKeyVar];
    if (nodeKey) env[nodeKeyVar] = nodeKey;
    if (resolved.credentialHome) applyAgentCredentialEnv(env, resolved.credentialHome);
    return {
      binding: {
        route, source: resolved.launch.effectiveCredentialSources?.[provider] ?? 'node',
        credentialId: resolved.launch.spaceCredentialIds?.[provider] ?? null,
        requesterIdentityId: input.requesterIdentityId, requesterAuthKind: input.requesterAuthKind,
        spaceId: input.spaceId, accountGeneration: null, materialRevision: null, hotReuse: false,
      },
      credentialHome: resolved.credentialHome, env,
    } satisfies ResolvedChatCredential;
  };
}

/** Legacy env adapter; generation composition uses the pure resolver directly. */
export function createChatCredentialEnvResolver(options: ChatCredentialResolverOptions): ResolveChatCredentialEnv {
  const resolve = createChatCredentialResolver(options);
  return async input => {
    const selected = await resolve(input);
    const home = selected.credentialHome;
    if (!input.credentialValidationOnly && home?.space?.apiKey) {
      const materialized = await materializeSpaceApiKeyHome({
        dataDir: options.dataDir, sessionId: input.chatId,
        provider: selected.binding.route.nativeProvider,
        credentialId: home.space.credentialId, apiKey: home.space.apiKey,
      });
      const env = { ...selected.env };
      applyAgentCredentialEnv(env, materialized);
      return env;
    }
    return selected.env;
  };
}
