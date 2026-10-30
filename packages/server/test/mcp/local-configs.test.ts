import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localMcpConfigPaths, readLocalMcpConfigs } from '../../src/mcp/local-configs.js';

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'tm8-local-mcp-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe('mcp.servers.local — the host Claude Code and Codex configs', () => {
  it('reads the paths `tm8 mcp import --from claude|codex` reads, env overrides included', () => {
    expect(localMcpConfigPaths({ HOME: '/h' })).toEqual([
      { format: 'claude', path: '/h/.claude.json' },
      { format: 'codex', path: '/h/.codex/config.toml' },
    ]);
    expect(localMcpConfigPaths({ HOME: '/h', CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/x' }).map(p => p.path))
      .toEqual(['/c/.claude.json', '/x/config.toml']);
  });

  it('answers found:false for a host with neither file', async () => {
    const { sources } = await readLocalMcpConfigs({ HOME: home });
    expect(sources).toEqual([
      { format: 'claude', path: '~/.claude.json', found: false, candidates: [], problems: [] },
      { format: 'codex', path: '~/.codex/config.toml', found: false, candidates: [], problems: [] },
    ]);
  });

  it('translates both files and never lets a literal credential leave the server', async () => {
    await writeFile(join(home, '.claude.json'), JSON.stringify({
      mcpServers: { docs: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer live-secret-123' } } },
      projects: { '/srv/app': { mcpServers: { local: { command: 'npx', args: ['-y', 'some-mcp'] } } } },
    }));
    await mkdir(join(home, '.codex'));
    await writeFile(join(home, '.codex', 'config.toml'), '[mcp_servers.context7]\nurl = "https://mcp.context7.com/mcp"\n');
    const result = await readLocalMcpConfigs({ HOME: home });
    expect(JSON.stringify(result)).not.toContain('live-secret-123');
    const [claude, codex] = result.sources;
    expect(claude?.found).toBe(true);
    expect(claude?.candidates.map(c => [c.definition.name, c.definition.transport, c.droppedSecret])).toEqual([
      ['docs', 'http', true],
      ['local', 'stdio', false],
    ]);
    expect(claude?.candidates.every(c => !('secret' in c))).toBe(true);
    expect(codex?.candidates.map(c => c.definition.url)).toEqual(['https://mcp.context7.com/mcp']);
  });

  it('reports an unparseable file without quoting it', async () => {
    await mkdir(join(home, '.codex'));
    await writeFile(join(home, '.codex', 'config.toml'), '[mcp_servers.x]\ntoken = @not-toml-secret\n');
    const codex = (await readLocalMcpConfigs({ HOME: home })).sources[1];
    expect(codex?.found).toBe(true);
    expect(codex?.error).toContain('tm8 mcp import --from codex --dry-run');
    expect(JSON.stringify(codex)).not.toContain('not-toml-secret');
  });
});
