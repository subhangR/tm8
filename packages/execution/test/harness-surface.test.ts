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
  asMcpServers,
  equippedClaudePlugins,
  harnessSurfaceEnv,
  laneSkillOverrides,
  pluginDecisions,
  pluginSettings,
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
/** The bundled-skill trim every minimal lane carries, pinned in full. */
const SKILL_OVERRIDES = `"skillOverrides":{"claude-api":"off","dataviz":"off","fewer-permission-prompts":"off","init":"off","keybindings-help":"off","loop":"off","run":"off","schedule":"off","update-config":"off"}`;
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
    expect(launch.mcpServers).toBeUndefined();
    expect(
      resolveLaunchConfig(REQUEST, context({ launch: { mcpServers: { l: { type: 'http', url: 'u' }, bad: 3 } } }), {})
        .mcpServers,
    ).toEqual({ l: { type: 'http', url: 'u' } });
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

describe('resolveLaunchConfig per-launch harness pick', () => {
  const persona = context({ launch: { harnessSurface: 'minimal', plugins: ['marketing'] } });

  it('the request outranks the node env and the persona, and is recorded', () => {
    const launch = resolveLaunchConfig(
      { ...REQUEST, harnessSurface: 'inherit' },
      persona,
      { TM8_HARNESS_SURFACE: 'minimal' },
    );
    expect(launch.harnessSurface).toBe('inherit');
    expect(launch.harnessChoice).toEqual({ surface: 'inherit' });
  });

  it('a plugin pick REPLACES the persona list; an empty pick means none', () => {
    expect(resolveLaunchConfig({ ...REQUEST, plugins: ['sales'] }, persona, {}).plugins).toEqual(['sales']);
    const none = resolveLaunchConfig({ ...REQUEST, plugins: [] }, persona, {});
    expect(none.plugins).toEqual([]);
    expect(none.harnessChoice).toEqual({ plugins: [] });
  });

  it('no pick: persona as before, and nothing recorded', () => {
    const launch = resolveLaunchConfig(REQUEST, persona, {});
    expect(launch.plugins).toEqual(['marketing']);
    expect('harnessChoice' in launch).toBe(false);
  });

  it('resume inherits the recorded pick, below the node env', () => {
    const inherited = {
      accessMode: null,
      permissionMode: null,
      harnessChoice: { surface: 'minimal', plugins: ['sales', 3] } as Record<string, unknown>,
    };
    const resumed = resolveLaunchConfig(REQUEST, persona, {}, inherited);
    expect(resumed.harnessSurface).toBe('minimal');
    expect(resumed.plugins).toEqual(['sales']);
    expect(resumed.harnessChoice).toEqual({ surface: 'minimal', plugins: ['sales'] });
    // Under a node-forced `inherit` the plugin pick has no effect, so it is not replayed.
    const forced = resolveLaunchConfig(REQUEST, persona, { TM8_HARNESS_SURFACE: 'inherit' }, inherited);
    expect(forced.harnessSurface).toBe('inherit');
    expect(forced.harnessChoice).toEqual({ surface: 'minimal' });
    // Junk in the stored document falls through to the ordinary chain.
    expect('harnessChoice' in resolveLaunchConfig(REQUEST, persona, {}, {
      accessMode: null, permissionMode: null, harnessChoice: { surface: 'everything' },
    })).toBe(false);
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
        `"rust-analyzer-lsp@claude-plugins-official":false,"sales@synced":false},${SKILL_OVERRIDES}}'`,
    );
    // Never the two blunt instruments: they drop user permissions/hooks and
    // every repo skill respectively.
    expect(cmd).not.toContain('--setting-sources');
    expect(cmd).not.toContain('--disable-slash-commands');
  });

  it('minimal with no installed plugins emits only the bundled-skill trim', () => {
    expect(buildAgentCommand(LAUNCH, {}, { claudeSessionId: 'uuid-1' })).toBe(
      `${BARE} ${STRICT_MCP} --settings '{${SKILL_OVERRIDES}}'`,
    );
  });

  it('trims only bundled skills lanes never use, keeping the review and workflow ones', () => {
    const off = Object.keys(laneSkillOverrides());
    for (const kept of ['code-review', 'simplify', 'security-review', 'workflow-authoring']) {
      expect(off).not.toContain(kept);
    }
    expect(buildAgentCommand({ ...LAUNCH, harnessSurface: 'inherit' })).not.toContain('skillOverrides');
  });

  it('keeps allowlisted plugins by bare name or full id', () => {
    const cmd = buildAgentCommand({ ...LAUNCH, plugins: ['sales', 'rust-analyzer-lsp@claude-plugins-official'] }, {}, {
      installedClaudePlugins: INSTALLED,
    });
    expect(cmd).toContain(
      `--settings '{"enabledPlugins":{"marketing@synced":false,` +
        `"rust-analyzer-lsp@claude-plugins-official":true,"sales@synced":true},${SKILL_OVERRIDES}}'`,
    );
  });

  it('keeps the plugin of an equipped plugin skill without a persona allowlist', () => {
    const cmd = buildAgentCommand(LAUNCH, {}, {
      installedClaudePlugins: INSTALLED,
      equippedClaudePlugins: ['sales'],
    });
    expect(cmd).toContain('"sales@synced":true');
    expect(cmd).toContain('"marketing@synced":false');
  });

  it('emits opted-in MCP servers as the strict --mcp-config', () => {
    const cmd = buildAgentCommand(
      { ...LAUNCH, mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } } },
      {},
      {},
    );
    expect(cmd).toContain(
      `--strict-mcp-config --mcp-config '{"mcpServers":{"linear":{"type":"http","url":"https://mcp.linear.app/mcp"}}}'`,
    );
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

describe('pluginSettings', () => {
  it('is sorted, disables the rest and explicitly enables the allowlist', () => {
    expect(pluginSettings(['b@m', 'a@m', 'c@synced'], ['c', 'not-installed'])).toEqual({
      'a@m': false,
      'b@m': false,
      'c@synced': true,
    });
  });
});

describe('pluginDecisions', () => {
  const installed = ['marketing@synced', 'ops@synced', 'sales@synced', 'x@m'];

  it('names the source of every enabled plugin and the reason for every disabled one', () => {
    expect(pluginDecisions(installed, { launchPick: null, persona: ['marketing'], effective: ['sales'] })).toEqual({
      allowed: [{ id: 'marketing@synced', source: 'persona' }, { id: 'sales@synced', source: 'effective-skill' }],
      denied: [{ id: 'ops@synced', because: 'not-chosen' }, { id: 'x@m', because: 'not-chosen' }],
    });
  });

  it('a launch pick replaces the persona list and records what it removed', () => {
    expect(pluginDecisions(installed, { launchPick: ['ops'], persona: ['marketing'], effective: [] })).toEqual({
      allowed: [{ id: 'ops@synced', source: 'launch' }],
      denied: [
        { id: 'marketing@synced', because: 'launch-pick' },
        { id: 'sales@synced', because: 'not-chosen' },
        { id: 'x@m', because: 'not-chosen' },
      ],
    });
  });
});

describe('equippedClaudePlugins', () => {
  it('names the plugins of live claude plugin-level equips only', () => {
    expect(
      equippedClaudePlugins([
        { provider: 'claude', level: 'plugin', loaderMetadata: { pluginName: 'sales' } },
        { provider: 'claude', level: 'plugin', loaderMetadata: { pluginName: 'sales' } },
        { provider: 'claude', level: 'plugin', missing: true, loaderMetadata: { pluginName: 'gone' } },
        { provider: 'codex', level: 'plugin', loaderMetadata: { pluginName: 'codex-only' } },
        { provider: 'claude', level: 'user', loaderMetadata: { pluginName: 'anthropic-skills' } },
        { provider: 'claude', level: 'plugin', loaderMetadata: {} },
      ]),
    ).toEqual(['sales']);
  });
});

describe('asMcpServers', () => {
  it('keeps object-valued entries only', () => {
    expect(asMcpServers({ a: { command: 'x' }, b: 'nope', ' ': {}, c: [1] })).toEqual({ a: { command: 'x' } });
    expect(asMcpServers(['x'])).toBeNull();
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
