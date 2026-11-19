import {
  CREDENTIAL_PROVIDERS,
  agentCredentialProviderFor,
  apiKeyBackendForModel,
  SpawnError,
  applyAgentCredentialEnv,
  isolateGitHubCredential,
  materializeSpaceApiKeyHome,
  resolveMemberCredentialHome,
  resolveSessionCredentials,
  type AgentCredentialHomePort,
  type AgentCredentialHome,
  type GitHubCredentialPort,
  type Logger,
  type ResolvedLaunchConfig,
  type SpaceCredentialPort,
} from '@tm8/execution';
import { launchModel } from '@tm8/contract';
import { join } from 'node:path';
import type { Db, DbClaims } from '../db/types.js';
import { DbAgentCredentialHome } from '../credentials/agent-credential-injection.js';
import { DbGitHubCredentialStore } from '../credentials/github-credential-store.js';
import { spaceCredentialPort } from '../credentials/space-credential-port.js';
import type { ChatLaunchConfigInput, ResolveChatCredentialEnv } from './runtime.js';

/**
 * Chat uses the same model credential ladder and policy gate as a fresh
 * session — and, since this change, the same GITHUB ladder.
 *
 * WHAT WAS BROKEN. `resolveMemberGitHub` was `async () => null` and
 * `modelOnly: true` discarded GitHub anyway, so a chat got no GitHub keys
 * from any rung. The result was a plain asymmetry: in a chat on a repo
 * `gh auth status` answered "not logged into any GitHub hosts" and a push was
 * refused, while a worker session for the SAME member in the SAME Space
 * pushed fine — because the session lane shapes its environment with
 * `composeEnv`, which calls `isolateGitHubCredential`, and the chat lane
 * (`composeChatEnv`) has no such step.
 *
 * WHAT IS STILL NOT GRANTED, AND ON PURPOSE. The node's own machine
 * credential. `chat-env.ts` excludes ambient `GH_TOKEN`/`GITHUB_TOKEN` from
 * the chat child by allow-list, and `shell-env.ts` gives the reason for the
 * terminal lane in the same words: the node's token is not the member's, and
 * a push authored by the box is an attribution bug. So a chat gets the
 * credential the MEMBER or the SPACE connected, read from the DB under the
 * turn author's own claims — never one inherited from the server process.
 */
export interface ChatCredentialResolverOptions {
  db: Db;
  dataDir: string;
  memberCredentials?: AgentCredentialHomePort;
  spaceCredentials?: SpaceCredentialPort;
  gitHubCredentials?: GitHubCredentialPort;
  logger?: Logger;
  parentEnv?: NodeJS.ProcessEnv;
}

export type ChatCredentialInput = ChatLaunchConfigInput & { readonly requesterAuthSessionId?: string };

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
  const gitHub = options.gitHubCredentials ?? new DbGitHubCredentialStore(options);

  return async (input: ChatCredentialInput): Promise<ResolvedChatCredential> => {
    const auth: DbClaims = {
      identityId: input.requesterIdentityId,
      ...(input.requesterAuthKind ? { authKind: input.requesterAuthKind } : {}),
      ...(input.requesterAuthSessionId ? { authSessionId: input.requesterAuthSessionId } : {}),
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
      // A chat answers without git rather than not answering: see the flag's
      // doc in credential-resolution.ts for why only chat sets this.
      gitHubOptional: true,
      linkBound: auth.authKind === 'link',
    }, {
      spaceCredentials: space,
      resolveMemberHome: source => resolveMemberCredentialHome(member, auth, input.agentTool, input.model, source),
      // The caller's own RLS-scoped row, exactly as `SpawnService` resolves it
      // — but a FAILURE to read it is not allowed to fail the turn.
      //
      // `SpawnService` deliberately lets this throw: for a session, degrading
      // to the node's machine login would be an attribution bug, and refusing
      // to spawn is the honest answer. A chat has a third option that a
      // session does not, and it is the same one `gitHubOptional` is for —
      // answer, without git. An undecryptable stored token would otherwise
      // make EVERY turn of that member's chats fail with an opaque error,
      // which is a worse outcome than `gh` being unauthenticated. The reason
      // is logged rather than swallowed, and the token never is.
      resolveMemberGitHub: async () => {
        try {
          return await gitHub.resolve(auth);
        } catch (error) {
          options.logger?.warn?.('chat: the member GitHub credential could not be read; this turn has no git', {
            chatId: input.chatId,
            reason: error instanceof Error ? error.message : 'unknown',
          });
          return null;
        }
      },
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
    // MEMBER POSTURE UNCONDITIONALLY — the one place chat is deliberately
    // STRICTER than a session. `composeEnv` passes `false` when the effective
    // rung is `node`, which lets a session fall through to the box's machine
    // gh. Chat cannot use that credential anyway (the allow-list in
    // `chat-env.ts` keeps ambient `GH_TOKEN` out), so the only thing a
    // non-strict posture could still reach is the node's GLOBAL git helper
    // and `~/.config/gh/hosts.yml`. Blanking them makes "this member has no
    // GitHub credential" fail as a clean, prompt-free authentication refusal
    // instead of silently pushing as whoever the box is logged in as.
    //
    // Placed after the model home only to match `composeEnv`'s order; the two
    // write disjoint keys, so neither can overwrite the other.
    isolateGitHubCredential(env, resolved.gitHubCredential ?? undefined, true);
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
