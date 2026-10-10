import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { CollabError, type McpSelection } from '@tm8/contract';
import {
  HarnessRegistry, connectorBridgeConfig,
  type GenerationFence, type HarnessTarget, type Json, type LaunchMaterial,
  type McpDescriptor, type PreparedLaunch,
} from '@tm8/execution';
import { MCP_TOOL_NAMES, exposedToolNames } from '@tm8/mcp';
import type { Db, DbClaims } from '../db/types.js';
import { hashToken, parseToken } from '../identity/crypto.js';
import {
  issueAgentRuntimeSession, revokeAgentRuntimeSession,
  type IssuedAgentRuntimeSession, type ResolvedAuthSession,
} from '../identity/pg-auth.js';
import { McpSessionBindings, type McpBindingClaims } from '../mcp/session-bindings.js';
import {
  ChatLaunchDirectory, createChatCredentialPreparation,
  type ChatCredentialPreparationPort,
} from './credential-boundary.js';
import { chatCredentialRoute, type ChatCredentialBinding, type ChatCredentialResolverOptions } from './credentials.js';
import { chatProviderToolPolicy, chatSystemPrompt } from './compose.js';
import type { ChatLaunchConfigInput } from './runtime.js';

export interface ChatPreparedLaunchInput extends ChatLaunchConfigInput {
  /** Verified original human session, supplied by the claimed turn snapshot. */
  readonly requesterAuthSessionId?: string;
  readonly reasoningEffort?: string | null;
  readonly serviceTier?: string | null;
}

export interface PreparedChatLaunch {
  readonly launch: PreparedLaunch;
  readonly credentialBinding: ChatCredentialBinding;
  readonly credentialBindingId: string;
  readonly credentialRevision: null;
  readonly launchFingerprint: null;
  readonly target: HarnessTarget;
  readonly instructionHash: string;
  readonly toolPolicyHash: string;
  readonly mcpBindingRevision: string;
  /** Live guarded reads only: never mint, rotate, bind or rewrite files. */
  revalidate(): Promise<void>;
}

export interface ChatHarnessComposition extends ChatCredentialResolverOptions {
  readonly baseUrl: string;
  readonly registry: HarnessRegistry;
  readonly credentialPreparation?: ChatCredentialPreparationPort;
  readonly mcpBindings?: Pick<McpSessionBindings, 'bind' | 'authorize'>;
  readonly mcpCliPath?: string;
  readonly skillsPluginDir?: string;
  readonly commands?: Partial<Record<'claude' | 'codex', string>>;
  readonly requiredCapabilities?: Parameters<HarnessRegistry['admit']>[1];
  /** Lifecycle may persist/retry a failed exact-grant revocation; never log private material. */
  readonly onCleanupFailure?: (retry: () => Promise<void>) => void;
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Translate only selected bridge descriptors; no raw connector definitions or vendor keys. */
export function chatCodexMcpSettings(servers: readonly McpDescriptor[]): Json {
  return { mcp_servers: Object.fromEntries(servers.map(server => [server.name, {
    command: server.command, args: [...server.args], env: { ...server.env },
    ...(server.cwd ? { cwd: server.cwd } : {}),
  }])) };
}

function claimsForLaunch(input: ChatPreparedLaunchInput): DbClaims {
  return {
    identityId: input.requesterIdentityId,
    ...(input.requesterAuthKind ? { authKind: input.requesterAuthKind } : {}),
    ...(input.requesterAuthSessionId ? { authSessionId: input.requesterAuthSessionId } : {}),
  };
}

/** Prepare after continuity reserves/seals the owner; release after confirmed process exit. */
export function createChatPreparedLaunchResolver(options: ChatHarnessComposition) {
  const credentials = options.credentialPreparation ?? createChatCredentialPreparation(options);
  const bindings = options.mcpBindings ?? new McpSessionBindings(options.db);
  const require = createRequire(import.meta.url);
  const cliPath = options.mcpCliPath ?? join(dirname(require.resolve('@tm8/mcp')), 'cli.js');

  return async (
    input: ChatPreparedLaunchInput, owner: PreparedLaunch['owner'], fence: GenerationFence,
  ): Promise<PreparedChatLaunch> => {
    if (input.chatId !== owner.chatId || input.chatId !== fence.chatId || owner.generation !== fence.generation
      || !fence.bindingId || !Number.isSafeInteger(fence.leaseEpoch) || fence.leaseEpoch < 1
      || !Number.isSafeInteger(fence.configRevision) || fence.configRevision < 1
      || input.credentialValidationOnly) {
      throw new CollabError('invalid_input', 'Chat launch requires a claimed generation');
    }
    const route = chatCredentialRoute(input);
    const target: HarnessTarget = {
      harness: route.harness, provider: route.catalogProvider, model: route.model,
      reasoningEffort: input.reasoningEffort ?? null, serviceTier: input.serviceTier ?? null,
    };
    // Admission precedes every resource write or runtime grant mint.
    await options.registry.admit(target, options.requiredCapabilities);
      const credential = await credentials.prepare(input, owner);
    let root: ChatLaunchDirectory | undefined;
    let grant: IssuedAgentRuntimeSession | undefined;
    let released = false;
    const claims = claimsForLaunch(input);
    const release = async () => {
      if (released) return;
      // A stale release can revoke only this exact grant, never a successor.
      const results = await Promise.allSettled([
        ...(grant ? [revokeAgentRuntimeSession(options.db, claims, input.chatId, { sessionId: grant.sessionId, fence })] : []),
        ...(root ? [root.release(owner)] : []), credential.release(owner),
      ]);
      if (results.some(result => result.status === 'rejected')) {
        throw new CollabError('upstream_unavailable', 'Chat launch cleanup is pending');
      }
      released = true;
    };
    try {
      const modelMaterial = await credential.materialize();
      const codexSettings = chatCodexMcpSettings([]) as Record<string, Json>;
      if (route.inferenceProvider === 'groq') {
        // Official transport: https://console.groq.com/docs/responses-api.
        // This custom provider never inherits an OpenAI account or ambient endpoint.
        if (modelMaterial.env.OPENAI_BASE_URL !== 'https://api.groq.com/openai/v1'
          || !modelMaterial.env.OPENAI_API_KEY) throw new Error('Groq route unavailable');
        codexSettings.model_providers = { groq: {
          name: 'Groq', base_url: modelMaterial.env.OPENAI_BASE_URL,
          env_key: 'OPENAI_API_KEY', wire_api: 'responses', requires_openai_auth: false,
        } };
      }
      root = await ChatLaunchDirectory.create(options.dataDir, owner);
      grant = await issueAgentRuntimeSession(options.db, claims, {
        chatId: input.chatId, teamMemberId: input.teammateId, fence,
      });
      const selections = await bindings.bind(claims, {
        sessionId: input.chatId, spaceId: input.spaceId, teamMemberId: input.teammateId,
        agentToken: grant.token, resume: true,
      });
      const tools = chatProviderToolPolicy(input.chatMode);
      const nativeTools = route.harness === 'claude' ? tools.availableTools : [];
      const tm8Tools = exposedToolNames(input.chatMode, MCP_TOOL_NAMES);
      const hiddenTools = route.harness === 'claude' ? tm8Tools.filter(name => !tools.allowedTools.includes(`mcp__tm8__${name}`)) : [];
      const connectorEnv = { TM8_BASE_URL: options.baseUrl, TM8_AGENT_RUNTIME_TOKEN: grant.token, TM8_CHAT_ID: input.chatId };
      const connectors = connectorBridgeConfig(selections);
      const descriptors: McpDescriptor[] = [
        { name: 'tm8', command: process.execPath, args: [cliPath], cwd: input.cwd, env: {
          ...connectorEnv, TM8_CHAT_MODE: input.chatMode, TM8_CHAT_SPACE_ID: input.spaceId,
          TM8_CHAT_HIDDEN_TOOLS: hiddenTools.join(','), TM8_CHAT_PROJECT_ROOT: input.cwd,
        } },
        ...Object.entries(connectors).map(([name, config]) => ({
          name, command: process.execPath, args: [cliPath, ...config.args.slice(-2)], cwd: input.cwd, env: connectorEnv,
        })),
      ];
      const allowedTools = [
        ...(route.harness === 'claude' ? tools.allowedTools : tm8Tools.map(name => `mcp__tm8__${name}`)),
        ...Object.keys(connectors).map(name => `mcp__${name}__*`),
      ];
      const instructionText = chatSystemPrompt(input);
      const capabilityDescriptor = {
        harness: route.harness, nativeTools, allowedTools,
        selections: selections.map((s: McpSelection) => ({ serverId: s.serverId, credentialId: s.credentialId ?? null })),
        skillsPluginDir: options.skillsPluginDir ?? null,
      };
      const capabilityPlanId = digest(capabilityDescriptor);
      const mcpConfigPath = await root.write('mcp.json', `${JSON.stringify({ mcpServers: Object.fromEntries(descriptors.map(s => [s.name, {
        command: s.command, args: s.args, env: s.env, ...(s.cwd ? { cwd: s.cwd } : {}),
      }])) }, null, 2)}\n`);
      const minted = grant;
      const revalidate = async () => {
        if (released) throw new CollabError('forbidden', 'Chat launch has been released');
        try {
          await credential.revalidate();
          // resolveBearerIdentity additionally touches last-used state. This check is read-only.
          const token = parseToken(minted.token);
          if (!token) throw new Error('Invalid grant');
          const runtime = await options.db.rpc<ResolvedAuthSession | null>({}, 'resolve_auth_session', [hashToken(token.secret)]);
          if (!runtime || runtime.sessionId !== minted.sessionId || runtime.kind !== 'agent_runtime'
            || runtime.identityId !== input.requesterIdentityId || runtime.runtimeChatId !== input.chatId
            || runtime.spaceId !== input.spaceId || runtime.runtimeEpoch !== fence.leaseEpoch
            || runtime.runtimeNativeGeneration !== fence.generation) throw new Error('Grant changed');
          const runtimeClaims: McpBindingClaims = {
            identityId: runtime.identityId, authKind: runtime.kind, authSessionId: runtime.sessionId,
            sessionSpaceId: input.spaceId,
          };
          for (const selection of selections) {
            const authorized = await bindings.authorize(runtimeClaims, input.chatId, selection.serverId);
            if ((authorized.credentialId ?? null) !== (selection.credentialId ?? null)) throw new Error('Connector account changed');
          }
        } catch {
          throw new CollabError('forbidden', 'Chat launch authorization is no longer available');
        }
      };
      const launch: PreparedLaunch = {
        kind: 'ephemeral-launch', launchId: root.id, storageScopeId: root.id,
        nativeStorageScopeId: credential.storageScopeId, nativeStorageGeneration: credential.nativeStorageGeneration,
        owner: { ...owner }, modelCredentialLeaseId: credential.leaseId,
        runtimeGrantId: minted.sessionId, capabilityPlanId,
        async materialize(): Promise<LaunchMaterial> {
          await revalidate();
          const currentMaterial = await credential.materialize();
          await revalidate();
          return {
            harness: route.harness, command: options.commands?.[route.harness] ?? route.harness,
            argvPrefix: [], cwd: input.cwd, ...currentMaterial, instructionText,
            providerConfig: route.harness === 'codex' ? { ...codexSettings, ...chatCodexMcpSettings(descriptors) as Record<string, Json> } : {
              ...(options.skillsPluginDir ? { pluginDir: options.skillsPluginDir } : {}),
            },
            mcpConfigPath, mcpServers: descriptors, nativeTools, allowedTools,
          };
        },
        release,
      };
      await revalidate();
      return {
        launch, target, credentialBinding: credential.binding, credentialBindingId: randomUUID(),
        credentialRevision: null, launchFingerprint: null,
        instructionHash: digest(instructionText), toolPolicyHash: capabilityPlanId,
        mcpBindingRevision: digest(capabilityDescriptor.selections), revalidate,
      };
    } catch {
      // Nothing was handed to execution yet, so these resources have no live process owner.
      try { await release(); }
      catch { options.onCleanupFailure?.(release); throw new CollabError('upstream_unavailable', 'Chat launch cleanup is pending'); }
      throw new CollabError('forbidden', 'Chat launch could not be prepared');
    }
  };
}
