import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  AGENT_CREDENTIAL_CONFIG_DIR_VAR,
  AGENT_CREDENTIAL_NODE_CONFIG_DIR,
  agentCredentialProviderFor,
} from '../spawn/agent-credentials.js';

/** Finite provider homes this node can have written to; never a recursive scan. */
export async function knownAgentConfigDirs(opts: {
  agentTool: string | null;
  dataDir?: string;
  home?: string;
}): Promise<string[]> {
  const provider = agentCredentialProviderFor(opts.agentTool);
  // Preserve the historical Claude fallback for an unknown/null tool, but get
  // every admitted tool and node directory from the credential table. There is
  // no provider switch here for the next provider to drift out of.
  const nodeConfigDir = AGENT_CREDENTIAL_NODE_CONFIG_DIR[provider ?? 'anthropic'];
  const nodeDir = join(opts.home ?? homedir(), nodeConfigDir);
  if (!provider || !opts.dataDir) return [nodeDir];
  let identities: import('node:fs').Dirent[];
  try {
    identities = await readdir(join(opts.dataDir, 'credentials'), { withFileTypes: true });
  } catch {
    return [nodeDir];
  }
  return [...new Set([
    ...identities
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('id_'))
      .map((entry) => {
        const identityHome = join(opts.dataDir!, 'credentials', entry.name);
        // Claude/Codex read the explicit `<home>/<provider>` configDir. A
        // HOME-scoped CLI instead reads its ordinary dot-directory beneath the
        // redirected member HOME; returning `<home>/<provider>` for Gemini,
        // Hermes or Cursor would search a directory the spawned CLI never read.
        return AGENT_CREDENTIAL_CONFIG_DIR_VAR[provider] === null
          ? join(identityHome, nodeConfigDir)
          : join(identityHome, provider);
      }),
    nodeDir,
  ])];
}
