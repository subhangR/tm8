import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Finite provider homes this node can have written to; never a recursive scan. */
export async function knownAgentConfigDirs(opts: {
  agentTool: string | null;
  dataDir?: string;
  home?: string;
}): Promise<string[]> {
  const provider = opts.agentTool === 'claude-code' ? 'anthropic'
    : opts.agentTool === 'codex' ? 'openai' : null;
  const nodeDir = join(opts.home ?? homedir(), opts.agentTool === 'codex' ? '.codex' : '.claude');
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
      .map((entry) => join(opts.dataDir!, 'credentials', entry.name, provider)),
    nodeDir,
  ])];
}
