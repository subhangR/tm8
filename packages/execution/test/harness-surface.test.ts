// The harness surface a Claude lane boots with. Pins the three facts that
// make `minimal` worth having — no MCP connectors, no non-allowlisted plugins,
// no harness Artifact tool — and that `inherit` and `--resume` do not lose or
// invent any of them.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAgentCommand,
  resolveLaunchConfig,
  withAgentResume,
  type ResolvedLaunchConfig,
} from '../src/spawn/manifest.js';
import {
  disabledPluginSettings,
  harnessSurfaceEnv,
  readInstalledClaudePlugins,
} from '../src/spawn/harness-surface.js';
import type { SpawnContext, SpawnRequest } from '../src/spawn/types.js';

const LAUNCH: ResolvedLaunchConfig = {
  mode: 'worker',
  model: 'opus',
  agentTool: 'claude-code',
  permissionMode: 'acceptEdits',
  accessMode: 'acceptEdits',
  reasoningEffort: null,
  credentialSource: null,
  credentialSources: { anthropic: 'node', openai: 'node', github: 'node' },
};

const BARE = "claude --permission-mode acceptEdits --model 'opus' --session-id 'uuid-1'";
const STRICT_MCP = `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`;
const INSTALLED = ['marketing@synced', 'sales@synced', 'rust-analyzer-lsp@claude-plugins-official'];

function context(capabilities: Record<string, unknown> = {}): SpawnContext {
  return {
    spaceId: 'space-1',
    project: null,
    teamMember: {
      id: 'tm-1',
      name: 'Draco',
      role: 'r',
      identity: 'i',
      memories: [],
      model: 'opus',
      agentTool: null,
      mode: 'worker',
      permissionMode: null,
      avatar: null,
      capabilities,
      commandPermissions: {},
    },
    tasks: [],
  };
}
const REQUEST: SpawnRequest = { spaceId: 'space-1', teamMemberId: 'tm-1' };

describe('resolveLaunchConfig harness surface', () => {
  it('defaults lanes to minimal with an empty allowlist', () => {
    const launch = resolveLaunchConfig(REQUEST, context(), {});
    expect(launch.harnessSurface).toBe('minimal');
    expect(launch.plugins).toEqual([]);
  });

  it('reads the teammate preference from capabilities.launch, narrowing junk', () => {
    const launch = resolveLaunchConfig(
      REQUEST,
      context({ launch: { harnessSurface: 'inherit', plugins: ['sales', 7, ' ', 'x@y'] } }),
      {},
    );
    expect(launch.harnessSurface).toBe('inherit');
    expect(launch.plugins).toEqual(['sales', 'x@y']);
    expect(
      resolveLaunchConfig(REQUEST, context({ launch: { harnessSurface: 'everything' } }), {})
        .harnessSurface,
    ).toBe('minimal');
  });

  it('lets the operator env override the persona node-wide', () => {
    const ctx = context({ launch: { harnessSurface: 'minimal' } });
    expect(resolveLaunchConfig(REQUEST, ctx, { TM8_HARNESS_SURFACE: 'inherit' }).harnessSurface).toBe(
      'inherit',
    );
  });
});

describe('buildAgentCommand harness surface', () => {
  it('minimal: strict empty MCP config and every installed plugin disabled', () => {
    const cmd = buildAgentCommand(LAUNCH, {}, {
      claudeSessionId: 'uuid-1',
      installedClaudePlugins: INSTALLED,
    });
    expect(cmd).toBe(
      `${BARE} ${STRICT_MCP} --settings '{"enabledPlugins":{"marketing@synced":false,` +
        `"rust-analyzer-lsp@claude-plugins-official":false,"sales@synced":false}}'`,
    );
    // Never the two blunt instruments: they drop user permissions/hooks and
    // every repo skill respectively.
    expect(cmd).not.toContain('--setting-sources');
    expect(cmd).not.toContain('--disable-slash-commands');
  });

  it('minimal with no installed plugins emits no --settings at all', () => {
    expect(buildAgentCommand(LAUNCH, {}, { claudeSessionId: 'uuid-1' })).toBe(`${BARE} ${STRICT_MCP}`);
  });

  it('keeps allowlisted plugins by bare name or full id', () => {
    const cmd = buildAgentCommand({ ...LAUNCH, plugins: ['sales', 'rust-analyzer-lsp@claude-plugins-official'] }, {}, {
      installedClaudePlugins: INSTALLED,
    });
    expect(cmd).toContain(`--settings '{"enabledPlugins":{"marketing@synced":false}}'`);
  });

  it('inherit leaves the argv exactly as the bare command', () => {
    expect(
      buildAgentCommand({ ...LAUNCH, harnessSurface: 'inherit' }, {}, {
        claudeSessionId: 'uuid-1',
        installedClaudePlugins: INSTALLED,
      }),
    ).toBe(BARE);
  });

  it('touches neither codex nor an operator wrapper', () => {
    const codex = buildAgentCommand({ ...LAUNCH, agentTool: 'codex', model: 'gpt-6' }, {}, {
      installedClaudePlugins: INSTALLED,
    });
    expect(codex).not.toContain('--strict-mcp-config');
    expect(buildAgentCommand(LAUNCH, { TM8_AGENT_CMD: 'my-agent' })).toBe('my-agent');
  });

  it('resume keeps every minimal-surface flag, before --resume', () => {
    const base = buildAgentCommand(LAUNCH, {}, { installedClaudePlugins: INSTALLED });
    const resumed = withAgentResume(base, '<sys/>', LAUNCH, 'uuid-9', {});
    expect(resumed.startsWith(base)).toBe(true);
    expect(resumed).toContain(STRICT_MCP);
    expect(resumed).toContain('"sales@synced":false');
    expect(resumed.endsWith("--resume 'uuid-9'")).toBe(true);
  });
});

describe('harnessSurfaceEnv', () => {
  it('disables the harness Artifact tool for minimal claude lanes only', () => {
    expect(harnessSurfaceEnv(LAUNCH)).toEqual({ CLAUDE_CODE_DISABLE_ARTIFACT: '1' });
    expect(harnessSurfaceEnv({ ...LAUNCH, harnessSurface: 'inherit' })).toEqual({});
    expect(harnessSurfaceEnv({ ...LAUNCH, agentTool: 'codex' })).toEqual({});
  });
});

describe('disabledPluginSettings', () => {
  it('is sorted and excludes the allowlist', () => {
    expect(disabledPluginSettings(['b@m', 'a@m', 'c@synced'], ['c'])).toEqual({
      'a@m': false,
      'b@m': false,
    });
  });
});

describe('readInstalledClaudePlugins', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('reads marketplace installs, claude.ai-synced plugins and enabled settings', async () => {
    dir = await mkdtemp(join(tmpdir(), 'tm8-plugins-'));
    await mkdir(join(dir, 'plugins', 'synced', 'bucket-1'), { recursive: true });
    await mkdir(join(dir, 'plugins', 'synced', '.bucket-1'), { recursive: true });
    await writeFile(
      join(dir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'lsp@official': [{ scope: 'user' }],
          // Installed for one checkout only: the repo's choice, left alone.
          'repo-tool@official': [{ scope: 'project', projectPath: '/x' }],
        },
      }),
    );
    await writeFile(
      join(dir, 'plugins', 'synced', 'bucket-1', 'manifest.json'),
      JSON.stringify({ plugins: [{ name: 'sales' }, { name: 'marketing' }, { nope: 1 }] }),
    );
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'extra@m': true, 'off@m': false } }),
    );
    expect(readInstalledClaudePlugins(dir)).toEqual([
      'extra@m',
      'lsp@official',
      'marketing@synced',
      'sales@synced',
    ]);
  });

  it('returns nothing for a home with no plugin state', async () => {
    dir = await mkdtemp(join(tmpdir(), 'tm8-plugins-'));
    expect(readInstalledClaudePlugins(dir)).toEqual([]);
    expect(readInstalledClaudePlugins(join(dir, 'missing'))).toEqual([]);
  });
});
