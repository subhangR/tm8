import {
  agentCredentialEnv, AGENT_CREDENTIAL_SUPPRESSED_ENV_KEYS,
  SPACE_CREDENTIAL_API_KEY_ENV, SPACE_CREDENTIAL_SUPPRESSED_ENV_KEYS,
  type AgentCredentialHome,
} from './agent-credentials.js';
import { apiKeyBackendEnv, isApiKeyCredentialProvider } from '../credentials/api-key-credentials.js';

/** Relocate, suppress ambient keys, then inject the selected backend/space key. */
export function applyAgentCredentialEnv(env: NodeJS.ProcessEnv, home: AgentCredentialHome): void {
  Object.assign(env, agentCredentialEnv(home));
  // C8 / ruling 13 — and this DELETE is the load-bearing half.
  //
  // Setting the config directory is not enough on a node whose own
  // `ANTHROPIC_API_KEY` is forwarded by `AUTH_ENV_KEYS` a few lines above:
  // measured against the real CLI, that key competes with — and with an
  // unpopulated identity home outright beats — the member's own login, so the
  // session would run on the node's key under the member's name with nothing
  // red anywhere. Scoped to the connected provider only, so a member who has
  // NOT connected keeps today's behaviour exactly.
  for (const key of AGENT_CREDENTIAL_SUPPRESSED_ENV_KEYS[home.provider]) {
    delete env[key];
  }

  // API-KEY BACKEND ROUTING — LAST, AND THE ORDER IS THE CORRECTNESS.
  //
  // A member who has connected Kimi runs `claude` against Moonshot, and one
  // who has connected Groq runs `codex` against Groq. Both are expressed the
  // same way: point the tool's vendor SDK at a different base URL and give it
  // the member's key. Nothing about the launch changes — same binary, same
  // manifest, same session row — which is why this is four lines rather than
  // a second spawn path.
  //
  // It must come after the suppression loop above, and for Groq that is not a
  // stylistic preference: `OPENAI_API_KEY` is BOTH the node key we delete and
  // the variable we set. Inject first and the delete silently removes the
  // member's key, leaving a session pointed at Groq's base URL with no
  // credential — a 401 far from here, with nothing in the environment to
  // suggest why. Suppress first, then route, and the node's value is gone and
  // the member's is the only one present.
  //
  // `apiKey` is absent for every file-shaped provider, so this branch is
  // inert for them rather than conditional on a provider list that would need
  // maintaining in a third place.
  if (isApiKeyCredentialProvider(home.provider) && home.apiKey) {
    Object.assign(env, apiKeyBackendEnv(home.provider, home.apiKey));
  }

  // A SPACE credential (design 01a0cfa8 §4), under the same law: every node
  // value for the provider is deleted FIRST and the space's key set LAST
  // (I4). For both providers the deleted name and the set name coincide, so
  // reversing the two steps would delete the space key and leave the session
  // keyless — or, with the order right but a node ANTHROPIC_AUTH_TOKEN left
  // in place, running on the node's bearer under the space's name.
  if (home.space) {
    for (const key of SPACE_CREDENTIAL_SUPPRESSED_ENV_KEYS[home.provider] ?? []) {
      delete env[key];
    }
    const keyVar = SPACE_CREDENTIAL_API_KEY_ENV[home.provider];
    if (keyVar && home.space.apiKey) env[keyVar] = home.space.apiKey;
  }
}
