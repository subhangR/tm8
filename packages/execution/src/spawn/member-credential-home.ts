import { agentCredentialProviderFor, type AgentCredentialHome, type AgentCredentialHomePort } from './agent-credentials.js';
import { API_KEY_PROVIDER_DISPLAY_NAME, apiKeyBackendForModel, isApiKeyCredentialProvider } from '../credentials/api-key-credentials.js';
import { SpawnError, type CredentialSource, type GraphAuth } from './types.js';

/** Member lookup and fail-closed backend validation shared by sessions and chat. */
export async function resolveMemberCredentialHome(
  port: AgentCredentialHomePort | undefined,
  auth: GraphAuth,
  agentTool: string,
  model: string | null,
  source: CredentialSource | null = null,
): Promise<AgentCredentialHome | null> {
  const backend = apiKeyBackendForModel(agentTool, model);
  if (backend) {
    const home = port
      ? await port.resolve(auth, { agentTool, model })
      : null;
    const name = API_KEY_PROVIDER_DISPLAY_NAME[backend];
    if (!home || home.provider !== backend) {
      throw new SpawnError(
        `${model} runs only on your own ${name} key, and no ${name} key is connected ` +
          'for your account — connect it under Settings → Connections, or pick a model ' +
          `that ${agentTool} runs natively`,
        'conflict',
        { agentTool, model, provider: backend },
      );
    }
    if (home.apiKey === undefined) {
      throw new SpawnError(
        `${model} runs only on your own ${name} key, and your connected ${name} key ` +
          'could not be read — reconnect it under Settings → Connections',
        'conflict',
        { agentTool, model, provider: backend },
      );
    }
    return home;
  }

  if (source === 'node') return null;
  const home = port
    ? await port.resolve(auth, { agentTool, model })
    : null;
  if (source === 'member' && !home && agentCredentialProviderFor(agentTool)) {
    throw new SpawnError(
      `credentialSources.${agentCredentialProviderFor(agentTool)} 'member' was requested but no active ${agentCredentialProviderFor(agentTool)} ` +
        'credential is connected for your account — connect it under Settings → Connections, ' +
        "or launch with the node credential ('node')",
      'conflict',
      { agentTool, provider: agentCredentialProviderFor(agentTool) },
    );
  }
  if (source === 'member' && home && isApiKeyCredentialProvider(home.provider)
    && home.apiKey === undefined) {
    throw new SpawnError(
      `credentialSources.${home.provider} 'member' was requested and a ${home.provider} ` +
        'credential is connected, but its stored key could not be read — reconnect it ' +
        "under Settings → Connections, or launch with the node credential ('node')",
      'conflict',
      // The ACTUAL provider, not the tool's native one, so the member is
      // pointed at the credential that is the problem.
      { agentTool, provider: home.provider },
    );
  }
  return home;
}
