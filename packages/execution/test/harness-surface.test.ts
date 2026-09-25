// The harness surface a Claude lane boots with. Pins the three facts that
// make `minimal` worth having — no MCP connectors, no non-allowlisted plugins,
// no harness Artifact tool — and that `inherit` and `--resume` do not lose or
// invent any of them.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  pluginSkillIds,
  LANE_SKILLS_ALWAYS_ON,
  laneSkillOverrides,
  laneSkillPlan,
  pluginDecisions,
  asRecordedSkillPlan,
  readConfigHomeSkills,
  readProjectSkillKeys,
  pluginSettings,
  readInstalledClaudePlugins,
  claudePluginConfigDir,
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
/** The fixed argv head of every minimal lane: no MCP servers, no Chrome block. */
const STRICT_MCP = `--strict-mcp-config --mcp-config '{"mcpServers":{}}' --no-chrome`;
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
        equippedClaudePlugins: ['sales'],
        // Even a skill plan handed in is ignored: inherit restores everything.
        skillOverrides: { astro: 'off', graphify: 'name-only' },
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
      allowed: [{ id: 'marketing@synced', source: 'persona', granularity: 'plugin' }, { id: 'sales@synced', source: 'effective-skill', granularity: 'plugin' }],
      denied: [{ id: 'ops@synced', because: 'not-chosen' }, { id: 'x@m', because: 'not-chosen' }],
    });
  });

  it('a launch pick replaces the persona list and records what it removed', () => {
    expect(pluginDecisions(installed, { launchPick: ['ops'], persona: ['marketing'], effective: [] })).toEqual({
      allowed: [{ id: 'ops@synced', source: 'launch', granularity: 'plugin' }],
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

describe('laneSkillPlan', () => {
  const home = [
    { key: 'docx', level: 'synced' as const },
    { key: 'astro', level: 'user' as const },
    { key: 'graphify', level: 'user' as const },
    { key: 'simplify', level: 'user' as const },
  ];

  it('offs unchosen operator skills by level, name-only for native equips, and records Chrome', () => {
    const plan = laneSkillPlan(home, [
      { level: 'user', loadPointer: '/graphify' },
      { level: 'project', loadPointer: '/repo-skill' },
      // Plugin skills ignore skillOverrides (probed): never named.
      { level: 'plugin', loadPointer: '/sales:call-prep' },
      // An indexed pointer is a path, not a command: never named.
      { level: 'user', loadPointer: '/home/x/.claude/skills/y/SKILL.md' },
    ]);
    expect(plan.settings).toMatchObject({
      docx: 'off', astro: 'off', graphify: 'name-only', 'repo-skill': 'name-only', init: 'off',
    });
    expect(Object.keys(plan.settings)).toEqual([...Object.keys(plan.settings)].sort());
    expect(plan.settings).not.toHaveProperty('sales:call-prep');
    expect(plan.record.off).toContainEqual({ name: 'astro', source: 'user-unselected' });
    expect(plan.record.off).toContainEqual({ name: 'docx', source: 'synced-unselected' });
    expect(plan.record.off.at(-1)).toEqual({ name: 'claude-in-chrome', source: 'chrome' });
    expect(plan.record.nameOnly).toEqual([
      { name: 'graphify', source: 'native-name-only' },
      { name: 'repo-skill', source: 'native-name-only' },
    ]);
  });

  it('keys an equipped synced skill bare, so name-only reaches it on 2.1.251 and 2.1.280+ alike', () => {
    const plan = laneSkillPlan([{ key: 'pdf', level: 'synced' }], [{ level: 'synced', loadPointer: '/anthropic-skills:pdf' }]);
    expect(plan.settings.pdf).toBe('name-only');
    expect(plan.settings).not.toHaveProperty('anthropic-skills:pdf');
    expect(plan.record.nameOnly).toEqual([{ name: 'pdf', source: 'native-name-only' }]);
  });

  it('never names the always-on list, even for an operator skill sharing a name or an equip', () => {
    const plan = laneSkillPlan(home, [{ level: 'user', loadPointer: '/code-review' }]);
    for (const name of LANE_SKILLS_ALWAYS_ON) expect(plan.settings).not.toHaveProperty(name);
    expect(LANE_SKILLS_ALWAYS_ON).toEqual(['code-review', 'security-review', 'simplify', 'workflow-authoring']);
  });

  it('an equipped native skill tm8 does not describe is named nowhere: not off, not name-only', () => {
    const plan = laneSkillPlan(home, [{ level: 'user', loadPointer: '/graphify', described: false }]);
    expect(plan.settings).not.toHaveProperty('graphify');
    expect(plan.record.off.map((o) => o.name)).not.toContain('graphify');
    expect(plan.record.nameOnly).toEqual([]);
    // Its unequipped neighbours are still off.
    expect(plan.settings.astro).toBe('off');
  });

  it('with nothing read, is exactly the bundled trim plus the Chrome record', () => {
    const plan = laneSkillPlan([], []);
    expect(plan.settings).toEqual(laneSkillOverrides());
    expect(plan.record.nameOnly).toEqual([]);
  });

  it('reaches argv through buildAgentCommand, and resume keeps it and --no-chrome', () => {
    const { settings } = laneSkillPlan(home, [{ level: 'user', loadPointer: '/graphify' }]);
    const base = buildAgentCommand(LAUNCH, {}, { skillOverrides: settings });
    expect(base).toContain(`"skillOverrides":${JSON.stringify(settings)}`);
    const resumed = withAgentResume(base, '<sys/>', LAUNCH, 'uuid-9', {});
    expect(resumed).toContain('--no-chrome');
    expect(resumed).toContain('"graphify":"name-only"');
    expect(buildAgentCommand({ ...LAUNCH, harnessSurface: 'inherit' }, {}, { skillOverrides: settings }))
      .not.toMatch(/no-chrome|skillOverrides/);
  });
});

describe('laneSkillPlan: a key reaches every skill of that name, so a project one is never hit', () => {
  const home = [
    { key: 'astro', level: 'user' as const },
    { key: 'docx', level: 'synced' as const },
    { key: 'tools:deploy', level: 'command' as const },
    { key: 'lint', level: 'command' as const },
  ];

  it('no collision: bare keys, commands off as command-unselected', () => {
    const plan = laneSkillPlan(home, []);
    expect(plan.settings).toMatchObject({ astro: 'off', docx: 'off', 'tools:deploy': 'off', lint: 'off' });
    expect(plan.record.off).toContainEqual({ name: 'tools:deploy', source: 'command-unselected' });
    expect(plan.record.kept).toBeUndefined();
  });

  it('a project skill sharing the name: user/command/bundled are left alone, synced goes qualified, all recorded', () => {
    const plan = laneSkillPlan(home, [], ['astro', 'docx', 'lint', 'run']);
    for (const key of ['astro', 'docx', 'lint', 'run']) expect(plan.settings).not.toHaveProperty(key);
    expect(plan.settings['anthropic-skills:docx']).toBe('off');
    expect(plan.record.off).toContainEqual({ name: 'anthropic-skills:docx', source: 'synced-unselected' });
    expect(plan.record.kept).toEqual(['astro', 'docx', 'lint', 'run'].map((name) => ({ name, because: 'project-collision' })));
    // The ones nothing collides with are still trimmed.
    expect(plan.settings).toMatchObject({ 'tools:deploy': 'off', init: 'off' });
  });
});

describe('asRecordedSkillPlan: resume replays what the launch recorded', () => {
  it('round-trips a fresh plan exactly: settings, --no-chrome and record', () => {
    const plan = laneSkillPlan([{ key: 'astro', level: 'user' }, { key: 'docx', level: 'synced' }], [{ level: 'user', loadPointer: '/graphify' }], ['docx']);
    const replayed = asRecordedSkillPlan(JSON.parse(JSON.stringify(plan.record)));
    expect(replayed).toEqual(plan);
  });

  it('a pre-#803 record (bundled trim only, no chrome entry) replays without --no-chrome', () => {
    const replayed = asRecordedSkillPlan({ off: [{ name: 'init', source: 'builtin-trim' }] });
    expect(replayed?.settings).toEqual({ init: 'off' });
    expect(replayed?.noChrome).toBe(false);
    expect(buildAgentCommand(LAUNCH, {}, { skillOverrides: replayed!.settings, noChrome: false })).not.toContain('--no-chrome');
  });

  it('refuses anything malformed rather than half-apply it', () => {
    for (const bad of [null, [], {}, { off: 'x' }, { off: [{ name: 'a' }] }, { off: [{ name: 'a', source: 'made-up' }] },
      { off: [], nameOnly: [{ name: 'b', source: 'builtin-trim' }] }, { off: [], nameOnly: 'x' }, { off: [{ name: '', source: 'builtin-trim' }] }]) {
      expect(asRecordedSkillPlan(bad)).toBeNull();
    }
  });
});

describe('readConfigHomeSkills', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('lists user skill dirs and synced skills by bare dir (2.1.251 lists them bare), only where SKILL.md exists', async () => {
    dir = await mkdtemp(join(tmpdir(), 'tm8-skills-'));
    for (const d of ['skills/astro', 'skills/empty', 'skills/.hidden', 'skills/synced/bucket/docx', 'skills/synced/.bucket/pdf']) {
      await mkdir(join(dir, d), { recursive: true });
    }
    await writeFile(join(dir, 'skills/astro/SKILL.md'), '---\nname: astro\n---\n');
    await writeFile(join(dir, 'skills/.hidden/SKILL.md'), 'x');
    await writeFile(join(dir, 'skills/synced/bucket/docx/SKILL.md'), 'x');
    await writeFile(join(dir, 'skills/synced/.bucket/pdf/SKILL.md'), 'x');
    await writeFile(join(dir, 'skills/synced/bucket/manifest.json'), '{}');
    expect(readConfigHomeSkills(dir)).toEqual([
      { key: 'astro', level: 'user' },
      { key: 'docx', level: 'synced' },
    ]);
  });

  it('lists legacy commands keyed by their path joined with ":" (a bare name misses a nested one)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'tm8-skills-'));
    await mkdir(join(dir, 'commands/tools'), { recursive: true });
    await writeFile(join(dir, 'commands/lint.md'), 'x');
    await writeFile(join(dir, 'commands/tools/deploy.md'), 'x');
    await writeFile(join(dir, 'commands/notes.txt'), 'x');
    expect(readConfigHomeSkills(dir)).toEqual([
      { key: 'lint', level: 'command' },
      { key: 'tools:deploy', level: 'command' },
    ]);
  });

  it('readProjectSkillKeys: the workdir own skills and commands', async () => {
    dir = await mkdtemp(join(tmpdir(), 'tm8-skills-'));
    await mkdir(join(dir, '.claude/skills/review'), { recursive: true });
    await mkdir(join(dir, '.claude/skills/no-file'), { recursive: true });
    await mkdir(join(dir, '.claude/commands/ops'), { recursive: true });
    await writeFile(join(dir, '.claude/skills/review/SKILL.md'), 'x');
    await writeFile(join(dir, '.claude/commands/ops/ship.md'), 'x');
    expect(readProjectSkillKeys(dir, dirname(dir))).toEqual(['ops:ship', 'review']);
    expect(readProjectSkillKeys(join(dir, 'missing'), join(dir, 'missing'))).toEqual([]);
  });

  it('readProjectSkillKeys: a workdir inside a repo also lists every parent up to the git root, as the harness does', async () => {
    // Probed on 2.1.280: cwd `repo/app` lists `repo/.claude` skills and
    // commands, and not a skill above the git root.
    dir = await mkdtemp(join(tmpdir(), 'tm8-skills-'));
    const repo = join(dir, 'repo');
    await mkdir(join(dir, '.claude/skills/above'), { recursive: true });
    await writeFile(join(dir, '.claude/skills/above/SKILL.md'), 'x');
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(join(repo, '.claude/skills/rooted'), { recursive: true });
    await writeFile(join(repo, '.claude/skills/rooted/SKILL.md'), 'x');
    await mkdir(join(repo, '.claude/commands'), { recursive: true });
    await writeFile(join(repo, '.claude/commands/ship.md'), 'x');
    await mkdir(join(repo, 'packages/app/.claude/skills/own'), { recursive: true });
    await writeFile(join(repo, 'packages/app/.claude/skills/own/SKILL.md'), 'x');
    expect(readProjectSkillKeys(join(repo, 'packages/app'), '/nonexistent-home')).toEqual(['own', 'rooted', 'ship']);
    // A worktree's `.git` is a file; the walk stops there too.
    await writeFile(join(repo, 'packages/.git'), 'gitdir: x');
    expect(readProjectSkillKeys(join(repo, 'packages/app'), '/nonexistent-home')).toEqual(['own']);
  });

  it('readProjectSkillKeys: outside a repo, the walk stops below home, whose .claude is the operator\'s', async () => {
    dir = await mkdtemp(join(tmpdir(), 'tm8-skills-'));
    await mkdir(join(dir, '.claude/skills/operator'), { recursive: true });
    await writeFile(join(dir, '.claude/skills/operator/SKILL.md'), 'x');
    await mkdir(join(dir, 'scratch/lane'), { recursive: true });
    expect(readProjectSkillKeys(join(dir, 'scratch/lane'), dir)).toEqual([]);
  });

  it('returns nothing for a home without skills', async () => {
    dir = await mkdtemp(join(tmpdir(), 'tm8-skills-'));
    expect(readConfigHomeSkills(dir)).toEqual([]);
  });
});

describe('claudePluginConfigDir', () => {
  it('uses the member home when given, else CLAUDE_CONFIG_DIR, else ~/.claude — one home, never a union', () => {
    expect(claudePluginConfigDir('/cred/anthropic', { CLAUDE_CONFIG_DIR: '/node', HOME: '/h' })).toBe('/cred/anthropic');
    expect(claudePluginConfigDir(undefined, { CLAUDE_CONFIG_DIR: '/node', HOME: '/h' })).toBe('/node');
    expect(claudePluginConfigDir(undefined, { CLAUDE_CONFIG_DIR: ' ', HOME: '/h' })).toBe('/h/.claude');
  });
});

describe('pluginSkillIds (F3)', () => {
  const row = (entityId: string, pluginName: string, extra: Record<string, unknown> = {}) => ({
    entityId, provider: 'claude', level: 'plugin', loaderMetadata: { pluginName }, ...extra,
  });
  it('maps each installed plugin to the skills that would turn it on, by the allowlist rule', () => {
    expect(pluginSkillIds(
      ['mcp-only@x', 'sales@synced', 'superpowers@official'],
      [
        row('sales-a', 'sales@synced'),
        row('sp-x', 'superpowers'),
        row('gone', 'sales@synced', { missing: true }),
        row('codex', 'sales@synced', { provider: 'codex' }),
        row('user', 'sales@synced', { level: 'user' }),
      ],
    )).toEqual({ 'sales@synced': ['sales-a'], 'superpowers@official': ['sp-x'] });
  });
});
