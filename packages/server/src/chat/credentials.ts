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
  type ResolvedLaunchConfig,
  type SpaceCredentialPort,
} from '@tm8/execution';
import { join } from 'node:path';
import type { Db, DbClaims } from '../db/types.js';
import { DbAgentCredentialHome } from '../credentials/agent-credential-injection.js';
import { spaceCredentialPort } from '../credentials/space-credential-port.js';
import type { ResolveChatCredentialEnv } from './runtime.js';

/** Chat uses the same model credential ladder and policy gate as a fresh session. */
export function createChatCredentialEnvResolver(options: {
  db: Db;
  dataDir: string;
  memberCredentials?: AgentCredentialHomePort;
  spaceCredentials?: SpaceCredentialPort;
  parentEnv?: NodeJS.ProcessEnv;
}): ResolveChatCredentialEnv {
  const member = options.memberCredentials ?? new DbAgentCredentialHome(options);
  const space = options.spaceCredentials ?? spaceCredentialPort(options.db, options.dataDir);
  return async (input) => {
    const auth: DbClaims = {
      identityId: input.requesterIdentityId,
      ...(input.requesterAuthKind ? { authKind: input.requesterAuthKind } : {}),
    };
    const selection = input.credentialSelection ?? { source: 'auto' };
    const provider = agentCredentialProviderFor(input.agentTool);
    if (selection.source === 'node' && apiKeyBackendForModel(input.agentTool, input.model)) {
      throw new SpawnError('This model requires your own connected provider key; server credentials cannot serve it', 'invalid_input');
    }
    const source = selection.source === 'auto' ? null : selection.source;
    const launch: ResolvedLaunchConfig = {
      mode: 'worker', model: input.model, agentTool: input.agentTool,
      permissionMode: 'bypassPermissions', accessMode: 'fullAccess', reasoningEffort: null,
      credentialSource: null,
      credentialSources: Object.fromEntries(CREDENTIAL_PROVIDERS.map(p => [p, p === provider ? source : null])) as ResolvedLaunchConfig['credentialSources'],
      ...(selection.credentialId ? { spaceCredentialIds: { [provider ?? 'anthropic']: selection.credentialId } } : {}),
    };
    const resolved = await resolveSessionCredentials({
      auth, spaceId: input.spaceId, launch, modelOnly: true,
      linkBound: auth.authKind === 'link',
    }, {
      spaceCredentials: space,
      resolveMemberHome: source => resolveMemberCredentialHome(member, auth, input.agentTool, input.model, source),
      resolveMemberGitHub: async () => null,
      materializeApiKeyHome: async grant => {
        if (input.credentialValidationOnly) {
          const homeDir = join(options.dataDir, 'credentials', 'sessions', input.chatId);
          return { provider: grant.provider, homeDir, configDir: join(homeDir, grant.provider),
            space: { credentialId: grant.credentialId, apiKey: grant.apiKey } };
        }
        return materializeSpaceApiKeyHome({ dataDir: options.dataDir, sessionId: input.chatId, ...grant });
      },
    });
    // Match session precedence, with no other ambient secrets copied into chat.
    const env: Record<string, string> = {};
    const nodeKey = (options.parentEnv ?? process.env).ANTHROPIC_API_KEY;
    if (nodeKey) env.ANTHROPIC_API_KEY = nodeKey;
    if (resolved.credentialHome) applyAgentCredentialEnv(env, resolved.credentialHome);
    return env;
  };
}
