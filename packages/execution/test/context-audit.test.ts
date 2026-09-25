// I2 — the launch-context audit (design 01a0d348 §6), the effective harness
// record (§3.6, F1) and the post-budget plugin allow set (§3.1/§3.2, F2).

import { describe, expect, it } from 'vitest';
import { serializeLinkedEntity, serializeSkillIndexEntry } from '@tm8/prompt';
import { computeEffectiveSkills } from '../src/spawn/effective-skills.js';
import { LANE_BUNDLED_SKILLS_OFF, LANE_SKILLS_ALWAYS_ON, type ConfigHomeSkill } from '../src/spawn/harness-surface.js';
import { childLaunchPosture, composeManifest, resolveLaunchConfig } from '../src/spawn/manifest.js';
import type { ResolvedSkillRow } from '../src/spawn/skills.js';
import type { SpawnContext, SpawnRequest } from '../src/spawn/types.js';

const HOME = '/home/test';
const request: SpawnRequest = { spaceId: 'space', teamMemberId: 'persona' };
const member = (extra: Partial<SpawnContext['teamMember']> = {}): SpawnContext['teamMember'] => ({
  id: 'persona', name: 'Persona', role: '', identity: '', memories: [], model: null, agentTool: 'claude-code',
  mode: 'worker', permissionMode: null, avatar: null, capabilities: {}, commandPermissions: {}, ...extra,
});
const ctx = (extra: Partial<SpawnContext> = {}): SpawnContext => ({
  spaceId: 'space', project: { id: 'project', name: 'repo', workingDir: '/repo', trust: 'trusted' }, tasks: [],
  teamMember: member(), ...extra,
});
const pluginSkill = (id: string, plugin: string, extra: Partial<ResolvedSkillRow> = {}): ResolvedSkillRow => ({
  entityId: id, name: `${plugin}-${id}`, dirName: `${plugin}-${id}`, description: 'plugin skill', depth: 0,
  provider: 'claude', level: 'plugin', sourcePath: `${HOME}/.claude/plugins/${plugin}/skills/${id}/SKILL.md`,
  loaderMetadata: { pluginName: plugin, enabled: false }, ...extra,
});

function compose(
  context: SpawnContext,
  opts: { req?: SpawnRequest; env?: NodeJS.ProcessEnv; installed?: string[] | null; homeSkills?: ConfigHomeSkill[] } = {},
) {
  const req = opts.req ?? request;
  let built: readonly string[] | null = null;
  let overrides: Readonly<Record<string, 'off' | 'name-only'>> | undefined;
  const manifest = composeManifest({
    sessionId: 'session', request: req, context, launch: resolveLaunchConfig(req, context, opts.env ?? {}),
    workdir: { mode: 'project', path: '/repo' }, baseUrl: 'http://localhost', homeDir: HOME,
    agentConfigDir: `${HOME}/.claude`, now: new Date('2026-09-24T00:00:00Z'),
    command: (plugins, skillOverrides) => { built = plugins; overrides = skillOverrides; return `claude plugins=${plugins.join(',')}`; },
    ...(opts.installed === null ? {} : { harness: { installedPlugins: opts.installed ?? [], skills: opts.homeSkills ?? [] } }),
  });
  return { manifest, plugins: built as readonly string[] | null, overrides };
}

describe('F2: computeEffectiveSkills honours launch-enabled plugins', () => {
  const base = { agentTool: 'claude-code', workdir: '/repo', projectRoot: '/repo', homeDir: HOME };
  it('a plugin this launch enables is native even when user settings leave it off', () => {
    const equips = [pluginSkill('a', 'sales')];
    expect(computeEffectiveSkills({ ...base, equips }).native).toEqual([]);
    const result = computeEffectiveSkills({ ...base, equips, launchEnabledPlugins: ['sales@synced'] });
    expect(result.native.map((s) => s.loadPointer)).toEqual(['/sales:sales-a']);
  });
  it('a plugin this launch does not enable is indexed even when user settings turn it on', () => {
    const equips = [pluginSkill('a', 'sales', { loaderMetadata: { pluginName: 'sales', enabled: true } })];
    expect(computeEffectiveSkills({ ...base, equips }).native).toHaveLength(1);
    expect(computeEffectiveSkills({ ...base, equips, launchEnabledPlugins: ['marketing@synced'] }).native).toEqual([]);
  });
});

describe('F2: the plugin allow set follows the post-budget effective skills', () => {
  it('an equipped plugin skill is native under a minimal lane and turns its plugin on', () => {
    const { manifest, plugins } = compose(ctx({ skillEquips: [pluginSkill('a', 'sales')] }), {
      installed: ['marketing@synced', 'sales@synced'],
    });
    expect(plugins).toEqual(['sales']);
    expect(manifest.launch.command).toBe('claude plugins=sales');
    expect(manifest.effectiveSkills?.native.map((s) => s.entityId)).toEqual(['a']);
    expect(manifest.launch.harness?.plugins).toEqual({
      allowed: [{ id: 'sales@synced', source: 'effective-skill', granularity: 'plugin' }],
      denied: [{ id: 'marketing@synced', because: 'not-chosen' }],
    });
  });

  it('a plugin skill dropped by the byte budget does not turn its plugin on', () => {
    // Enough skills to overflow the 32 KiB index; the plugin skill is last, so it is dropped.
    const filler: ResolvedSkillRow[] = Array.from({ length: 400 }, (_, i) => ({
      entityId: `s${i}`, name: `skill-${i}`, depth: 0, description: `does thing ${i} `.repeat(8),
    }));
    const { manifest, plugins } = compose(ctx({ skillEquips: [...filler, pluginSkill('late', 'sales')] }), {
      installed: ['sales@synced'],
    });
    expect(manifest.effectiveSkills?.skipped).toContainEqual(expect.objectContaining({ entityId: 'late', reason: 'byte-budget' }));
    expect(plugins).toEqual([]);
    expect(manifest.launch.harness?.plugins).toEqual({ allowed: [], denied: [{ id: 'sales@synced', because: 'not-chosen' }] });
    expect(manifest.context?.dropped).toContainEqual({ entityId: 'late', kind: 'skill', group: 'skills', reason: 'byte-budget', level: 'entry' });
  });

  it('without a managed harness the command string is recorded as given and no harness is written', () => {
    const context = ctx();
    const manifest = composeManifest({
      sessionId: 'session', request, context, launch: resolveLaunchConfig(request, context, {}),
      workdir: { mode: 'project', path: '/repo' }, baseUrl: 'http://localhost', command: 'claude --model x',
    });
    expect(manifest.launch.command).toBe('claude --model x');
    expect('harness' in manifest.launch).toBe(false);
  });
});

describe('F1: launch.harness records surface, source, MCP servers and skill overrides', () => {
  it('a default minimal lane records the builtin trim and no MCP servers', () => {
    const { manifest } = compose(ctx());
    expect(manifest.launch.harness).toEqual({
      surface: 'minimal',
      surfaceSource: 'default',
      mcpServers: [],
      skillOverrides: {
        off: [
          ...LANE_BUNDLED_SKILLS_OFF.map((name) => ({ name, source: 'builtin-trim' })),
          { name: 'claude-in-chrome', source: 'chrome' },
        ],
        nameOnly: [],
      },
    });
  });

  it('records persona MCP server NAMES only, never their configs', () => {
    const context = ctx({
      teamMember: member({
        capabilities: { launch: { mcpServers: { linear: { type: 'http', url: 'https://x', headers: { Authorization: 'Bearer secret' } }, a: { type: 'stdio' } } } },
      }),
    });
    const { manifest } = compose(context);
    expect(manifest.launch.harness?.mcpServers).toEqual([{ name: 'a', source: 'persona' }, { name: 'linear', source: 'persona' }]);
    expect(JSON.stringify(manifest.launch.harness)).not.toContain('secret');
  });

  it('names who chose the surface: launch pick, env, persona', () => {
    expect(compose(ctx(), { req: { ...request, harnessSurface: 'inherit' } }).manifest.launch.harness)
      .toEqual({ surface: 'inherit', surfaceSource: 'launch' });
    expect(compose(ctx(), { env: { TM8_HARNESS_SURFACE: 'inherit' } }).manifest.launch.harness)
      .toEqual({ surface: 'inherit', surfaceSource: 'env' });
    const persona = ctx({ teamMember: member({ capabilities: { launch: { harnessSurface: 'minimal' } } }) });
    expect(compose(persona).manifest.launch.harness).toMatchObject({ surface: 'minimal', surfaceSource: 'persona' });
  });
});

const userSkill = (id: string, extra: Partial<ResolvedSkillRow> = {}): ResolvedSkillRow => ({
  entityId: id, name: id, dirName: id, description: `${id} skill`, depth: 0,
  provider: 'claude', level: 'user', sourcePath: `${HOME}/.claude/skills/${id}/SKILL.md`, ...extra,
});
const HOME_SKILLS: ConfigHomeSkill[] = [
  { key: 'anthropic-skills:docx', level: 'synced' },
  { key: 'astro', level: 'user' },
  { key: 'code-review', level: 'user' },
  { key: 'graphify', level: 'user' },
];

describe('the harness loads only what the launch chose: operator skills, name-only, Chrome', () => {
  it('turns off unequipped operator skills, name-only for an equipped native one, argv == record', () => {
    const { manifest, overrides } = compose(ctx({ skills: [userSkill('graphify')] }), { homeSkills: HOME_SKILLS });
    expect(manifest.effectiveSkills?.native.map((s) => s.loadPointer)).toEqual(['/graphify']);
    expect(overrides).toMatchObject({ 'anthropic-skills:docx': 'off', astro: 'off', graphify: 'name-only' });
    // The always-on list is never named, even by an operator skill sharing a name.
    for (const name of LANE_SKILLS_ALWAYS_ON) expect(overrides).not.toHaveProperty(name);
    const record = manifest.launch.harness?.skillOverrides;
    expect(record?.nameOnly).toEqual([{ name: 'graphify', source: 'native-name-only' }]);
    expect(record?.off).toEqual(expect.arrayContaining([
      { name: 'anthropic-skills:docx', source: 'synced-unselected' },
      { name: 'astro', source: 'user-unselected' },
      { name: 'claude-in-chrome', source: 'chrome' },
    ]));
    // No trim is silent, and the record invents nothing the argv lacks.
    const recorded = [...record!.off.filter((o) => o.source !== 'chrome'), ...record!.nameOnly!].map((o) => o.name).sort();
    expect(recorded).toEqual(Object.keys(overrides!).sort());
  });

  it('an equipped skill that did not survive into the effective set is turned off, not kept', () => {
    const { overrides, manifest } = compose(ctx({ skills: [userSkill('graphify', { missing: true })] }), { homeSkills: HOME_SKILLS });
    expect(overrides?.graphify).toBe('off');
    expect(manifest.launch.harness?.skillOverrides?.nameOnly).toEqual([]);
  });

  it('an equipped native skill that shares a bundled-trim name wins: name-only, not off', () => {
    const { overrides, manifest } = compose(ctx({ skills: [userSkill('loop')] }), { homeSkills: [] });
    expect(overrides?.loop).toBe('name-only');
    expect(manifest.launch.harness?.skillOverrides?.off.map((o) => o.name)).not.toContain('loop');
  });

  it('inherit names no skill and records no trim', () => {
    const { overrides, manifest } = compose(ctx({ skills: [userSkill('graphify')] }), {
      homeSkills: HOME_SKILLS, env: { TM8_HARNESS_SURFACE: 'inherit' },
    });
    expect(overrides).toBeUndefined();
    expect(manifest.launch.harness).toEqual({ surface: 'inherit', surfaceSource: 'env' });
  });

  it('an unmanaged harness (no harness input) leaves the builder on the bundled default', () => {
    const { overrides, manifest } = compose(ctx({ skills: [userSkill('graphify')] }), { installed: null });
    expect(overrides).toBeUndefined();
    expect('harness' in manifest.launch).toBe(false);
  });
});

describe('manifest.context: entries, dropped, groups', () => {
  it('records each kind with its via, state and rendered bytes, and every drop', () => {
    const skills: ResolvedSkillRow[] = [
      { entityId: 'own', name: 'own', depth: 0, description: 'd' },
      { entityId: 'parent', name: 'parent', depth: 1, description: 'd' },
      { entityId: 'task-skill', name: 'task-skill', depth: -1, description: 'd', viaTaskId: 'task-1' },
      { entityId: 'picked', name: 'picked', depth: 0, description: 'd' },
    ];
    const linked = Array.from({ length: 18 }, (_, i) => ({
      entityId: `doc-${i}`, kind: i === 0 ? 'team_member' : 'doc', link: i === 0 ? 'relates_to' : 'attached_to', title: `t${i}`,
    }));
    const context = ctx({
      teamMember: member({ memories: ['first', 'second <b>', 'legacy'], memoryIds: ['m1', 'm2'] }),
      skillEquips: skills,
      skippedSkills: [{ entityId: 'unticked', name: 'unticked', reason: 'not-selected' }],
      tasks: [{
        id: 'task-1', version: 1, title: 'T', description: '', priority: 'low', status: 'open', acceptanceCriteria: [],
        attachments: [{ fileEntityId: 'file-1', name: 'a.txt', mime: 'text/plain' }],
        linked, linkedTotal: 40,
      }],
      contextAudit: {
        selectedGroups: ['memories', 'skills'],
        memoryVia: ['selection', 'selection'],
        selectionOnlySkillIds: ['picked'],
        dropped: [{ entityId: 'm-default', kind: 'memory', group: 'memories', reason: 'not-selected' }],
        legacyMemoriesDropped: 1,
      },
    });
    const { manifest } = compose(context, {
      req: { ...request, selection: { memoryIds: ['m1', 'm2'], skillIds: ['picked'] }, selectionReasons: { references: 'jev-failed' } },
    });
    const audit = manifest.context!;
    expect(audit.memoryIds).toEqual(['m1', 'm2']);
    expect(audit.groups).toEqual({
      memories: { mode: 'selected', legacyDropped: 1 },
      skills: { mode: 'selected' },
      references: { mode: 'default', reason: 'jev-failed', unread: 22 },
      teammates: { mode: 'default', reason: 'not-selectable' },
    });
    const by = (group: string) => audit.entries!.filter((e) => e.group === group);
    expect(by('memories')).toEqual([
      { entityId: 'm1', kind: 'memory', group: 'memories', via: 'selection', state: 'expanded', bytes: '<entry>first</entry>'.length, rank: 1 },
      { entityId: 'm2', kind: 'memory', group: 'memories', via: 'selection', state: 'expanded', bytes: '<entry>second &lt;b&gt;</entry>'.length, rank: 2 },
    ]);
    expect(by('skills').map((e) => [e.entityId, e.via, e.state])).toEqual([
      ['own', 'teammate', 'collapsed'], ['parent', 'inherited', 'collapsed'],
      ['task-skill', 'task', 'collapsed'], ['picked', 'selection', 'collapsed'],
    ]);
    const own = manifest.skills.find((s) => s.entityId === 'own')!;
    expect(by('skills')[0]!.bytes).toBe(Buffer.byteLength(serializeSkillIndexEntry(own)) + 1);
    expect(by('teammates')).toEqual([{
      entityId: 'doc-0', kind: 'team_member', group: 'teammates', via: 'linked', link: 'relates_to', state: 'collapsed',
      rank: 1, bytes: Buffer.byteLength(serializeLinkedEntity(linked[0]!)),
    }]);
    // 16 linked rows are shown (1 teammate + 15 docs) plus the attached file.
    expect(by('references').map((e) => e.entityId)).toEqual([...linked.slice(1, 16).map((l) => l.entityId), 'file-1']);
    expect(by('references').at(-1)).toMatchObject({ via: 'attached', kind: 'file', link: 'attached_to' });
    expect(audit.dropped).toEqual([
      { entityId: 'm-default', kind: 'memory', group: 'memories', reason: 'not-selected' },
      { entityId: 'unticked', kind: 'skill', group: 'skills', reason: 'not-selected' },
      { entityId: 'doc-16', kind: 'doc', group: 'references', reason: 'count-cap', level: 'entry' },
      { entityId: 'doc-17', kind: 'doc', group: 'references', reason: 'count-cap', level: 'entry' },
    ]);
    // Ids and enums only: no graph text reaches the audit.
    expect(JSON.stringify(audit)).not.toMatch(/first|second|t1\b|a\.txt/);
  });

  it('without a selection every group is the defaults', () => {
    const { manifest } = compose(ctx());
    expect(manifest.context?.groups).toEqual({
      memories: { mode: 'default', reason: 'no-selection' },
      skills: { mode: 'default', reason: 'no-selection' },
      references: { mode: 'default', reason: 'no-selection' },
      teammates: { mode: 'default', reason: 'not-selectable' },
    });
    expect(manifest.context?.entries).toEqual([]);
    expect(manifest.context?.dropped).toEqual([]);
  });

  it('records the client reason per defaulted group: the CLI, a failed or pending Jev group, never asked', () => {
    const cli = compose(ctx(), { req: { ...request, selectionReasons: { memories: 'cli', skills: 'cli', references: 'cli' } } });
    expect(cli.manifest.context?.groups).toEqual({
      memories: { mode: 'default', reason: 'cli' },
      skills: { mode: 'default', reason: 'cli' },
      references: { mode: 'default', reason: 'cli' },
      teammates: { mode: 'default', reason: 'not-selectable' },
    });
    const sheet = compose(ctx({ contextAudit: { selectedGroups: ['skills'], memoryVia: [], dropped: [] } }), {
      req: { ...request, selection: { skillIds: [] }, selectionReasons: { memories: 'jev-pending', references: 'not-asked' } },
    });
    expect(sheet.manifest.context?.groups).toMatchObject({
      memories: { mode: 'default', reason: 'jev-pending' },
      skills: { mode: 'selected' },
      references: { mode: 'default', reason: 'not-asked' },
    });
  });

  it('selected references: mode per group, removed defaults not-selected, unrendered selection-only ones recorded', () => {
    const context = ctx({
      tasks: [{
        id: 'task-1', version: 1, title: 'T', description: '', priority: 'low', status: 'open', acceptanceCriteria: [],
        attachments: [], linked: [{ entityId: 'doc-kept', kind: 'doc', link: 'attached_to', title: 'kept' }], linkedTotal: 1,
      }],
      references: [
        { entityId: 'doc-kept', kind: 'doc', title: 'kept', via: 'linked', link: 'attached_to' },
        { entityId: 'jev-pick', kind: 'artifact', title: 'Quarterly Plan', via: 'selection' },
      ],
      contextAudit: {
        selectedGroups: ['references'],
        memoryVia: [],
        dropped: [{ entityId: 'doc-unticked', kind: 'drawing', group: 'references', reason: 'not-selected' }],
      },
    });
    const { manifest } = compose(context, { req: { ...request, selection: { referenceIds: ['doc-kept', 'jev-pick'] } } });
    expect(manifest.context?.groups?.references).toEqual({ mode: 'selected' });
    expect(manifest.context?.groups?.memories).toEqual({ mode: 'default', reason: 'no-selection' });
    expect(manifest.context?.dropped).toEqual([
      { entityId: 'doc-unticked', kind: 'drawing', group: 'references', reason: 'not-selected' },
      { entityId: 'jev-pick', kind: 'artifact', group: 'references', reason: 'not-rendered', level: 'entry' },
    ]);
    expect(manifest.context?.entries?.map((e) => e.entityId)).toEqual(['doc-kept']);
    expect(JSON.stringify(manifest.context)).not.toContain('Quarterly Plan');
  });

  it('puts every id in exactly one place: a de-selected snapshot row is only not-selected; an unread kept default is count-cap', () => {
    const context = ctx({
      tasks: [{
        id: 'task-1', version: 1, title: 'T', description: '', priority: 'low', status: 'open', acceptanceCriteria: [],
        attachments: [{ fileEntityId: 'file-unticked', name: 'a.txt', mime: 'text/plain' }],
        linked: [
          { entityId: 'doc-kept', kind: 'doc', link: 'attached_to', title: 'kept' },
          { entityId: 'doc-unticked', kind: 'doc', link: 'attached_to', title: 'gone' },
          { entityId: 'run-1', kind: 'work_session', link: 'relates_to', title: null },
        ],
        // One more link than the spawn read: 'doc-unread' is past LINKED_ROW_CAP.
        linkedTotal: 4,
      }],
      references: [
        { entityId: 'doc-kept', kind: 'doc', title: 'kept', via: 'linked', link: 'attached_to' },
        { entityId: 'doc-unread', kind: 'doc', title: 'unread', via: 'linked', link: 'relates_to' },
      ],
      contextAudit: {
        selectedGroups: ['references'],
        memoryVia: [],
        dropped: [
          { entityId: 'doc-unticked', kind: 'doc', group: 'references', reason: 'not-selected' },
          { entityId: 'file-unticked', kind: 'file', group: 'references', reason: 'not-selected' },
        ],
      },
    });
    const audit = compose(context, { req: { ...request, selection: { referenceIds: ['doc-kept', 'doc-unread'] } } }).manifest.context!;
    // A session link is not a selectable kind: it stays an entry.
    expect(audit.entries?.map((e) => e.entityId)).toEqual(['doc-kept', 'run-1']);
    expect(audit.dropped).toEqual([
      { entityId: 'doc-unticked', kind: 'doc', group: 'references', reason: 'not-selected' },
      { entityId: 'file-unticked', kind: 'file', group: 'references', reason: 'not-selected' },
      { entityId: 'doc-unread', kind: 'doc', group: 'references', reason: 'count-cap', level: 'entry' },
    ]);
    const entryIds = new Set(audit.entries?.map((e) => e.entityId));
    expect(audit.dropped?.filter((d) => entryIds.has(d.entityId))).toEqual([]);
    expect(new Set(audit.dropped?.map((d) => d.entityId)).size).toBe(audit.dropped?.length);
  });

  it('a resume that could not parse the recorded selection says replay-invalid, never no-selection', () => {
    const { manifest } = compose(ctx(), { req: { ...request, selectionReplayInvalid: true } });
    expect(manifest.context?.groups).toMatchObject({
      memories: { mode: 'default', reason: 'replay-invalid' },
      skills: { mode: 'default', reason: 'replay-invalid' },
      references: { mode: 'default', reason: 'replay-invalid' },
      teammates: { mode: 'default', reason: 'not-selectable' },
    });
  });
});

describe('#731 follow-ups: when a harness pick applies', () => {
  const posture = { accessMode: null, permissionMode: null };
  it('(3) a plugin pick under a resolved inherit surface is neither applied nor recorded', () => {
    const persona = ctx({ teamMember: member({ capabilities: { launch: { plugins: ['sales'] } } }) });
    const launch = resolveLaunchConfig({ ...request, plugins: [] }, persona, { TM8_HARNESS_SURFACE: 'inherit' });
    expect(launch.harnessSurface).toBe('inherit');
    expect(launch.harnessChoice).toBeUndefined();
    expect(launch.plugins).toEqual(['sales']);
    // A surface pick in the same request is still recorded, without its plugins.
    const both = resolveLaunchConfig({ ...request, harnessSurface: 'inherit', plugins: ['x'] }, persona, {});
    expect(both.harnessChoice).toEqual({ surface: 'inherit' });
    // Under minimal the pick applies as before.
    expect(resolveLaunchConfig({ ...request, plugins: [] }, persona, {}).harnessChoice).toEqual({ plugins: [] });
  });

  it('(4) a child does not inherit the parent harness pick; resume replays it', () => {
    const parent = { ...posture, harnessChoice: { surface: 'inherit', plugins: [] } };
    expect(childLaunchPosture(parent)).toEqual({ ...posture, harnessChoice: null });
    expect(childLaunchPosture(posture)).toBe(posture);
    expect(childLaunchPosture(null)).toBeNull();
    const persona = ctx({ teamMember: member({ capabilities: { launch: { plugins: ['sales'] } } }) });
    const child = resolveLaunchConfig(request, persona, {}, childLaunchPosture(parent));
    expect(child.plugins).toEqual(['sales']);
    expect(child.harnessSurface).toBe('minimal');
    expect(child.harnessChoice).toBeUndefined();
    // Resume passes the recorded posture whole, so the pick is replayed.
    const resumed = resolveLaunchConfig(request, persona, {}, { ...posture, harnessChoice: { plugins: [] } });
    expect(resumed.plugins).toEqual([]);
  });

  it('(5) a non-Claude tool records no harness pick, so it cannot hand one on', () => {
    const codex = ctx({ teamMember: member({ agentTool: 'codex' }) });
    const launch = resolveLaunchConfig({ ...request, agentTool: 'codex', harnessSurface: 'minimal', plugins: ['sales'] }, codex, {});
    expect(launch.harnessChoice).toBeUndefined();
  });
});
