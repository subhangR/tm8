/**
 * `mcp.servers.local` — the tm8 host's own Claude Code and Codex MCP configs.
 *
 * Every tm8 launcher passes `--strict-mcp-config`, so a connector in
 * `~/.claude.json` or `~/.codex/config.toml` never reaches a tm8 chat or
 * session. The connector settings' import box takes a pasted file; this reads
 * the two files the host already has, at the same paths `tm8 mcp import
 * --from claude|codex` reads, and runs them through the same translator.
 *
 * SECRETS STAY HERE. The translator lifts a literal header or env token into
 * `candidate.secret`; it is dropped before the answer leaves this module and
 * only `droppedSecret` says one was there. The member connects their own
 * account afterwards, exactly as with a pasted file.
 */
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { translateMcpConfigText, type McpLocalConfigSource, type McpLocalConfigsResult } from '@tm8/contract';

type Env = Partial<Record<'HOME' | 'CODEX_HOME' | 'CLAUDE_CONFIG_DIR', string>>;

/** The CLI's `defaultPath` (commands/mcp-import.ts), for the two host formats. */
export function localMcpConfigPaths(env: Env = process.env): Array<{ format: 'claude' | 'codex'; path: string }> {
  const home = env.HOME || homedir();
  return [
    { format: 'claude', path: join(env.CLAUDE_CONFIG_DIR || home, '.claude.json') },
    { format: 'codex', path: join(env.CODEX_HOME || join(home, '.codex'), 'config.toml') },
  ];
}

export async function readLocalMcpConfigs(env: Env = process.env): Promise<McpLocalConfigsResult> {
  const home = env.HOME || homedir();
  const shown = (path: string) => path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
  const sources = await Promise.all(localMcpConfigPaths(env).map(async ({ format, path }): Promise<McpLocalConfigSource> => {
    const base = { format, path: shown(path), candidates: [], problems: [] };
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...base, found: false };
      return { ...base, found: true, error: 'This file could not be read.' };
    }
    try {
      const { candidates, problems } = translateMcpConfigText(format, text, { sourceLabel: shown(path) });
      return {
        ...base, found: true, problems,
        candidates: candidates.map(({ secret, ...candidate }) => ({ ...candidate, droppedSecret: secret !== undefined })),
      };
    } catch {
      // Not the translator's message: the TOML reader quotes the start of a
      // value it cannot read, and that value may be the token.
      return { ...base, found: true, error: `This file could not be parsed. Run \`tm8 mcp import --from ${format} --dry-run\` on the host for the reason.` };
    }
  }));
  return { sources };
}
