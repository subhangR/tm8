// I2 — the launch-context audit (design 01a0d348 §6), the effective harness
// record (§3.6, F1) and the post-budget plugin allow set (§3.1/§3.2, F2).

import { describe, expect, it } from 'vitest';
import { serializeLinkedEntity, serializeSkillIndexEntry } from '@tm8/prompt';
import { computeEffectiveSkills } from '../src/spawn/effective-skills.js';
import { LANE_BUNDLED_SKILLS_OFF } from '../src/spawn/harness-surface.js';
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
  opts: { req?: SpawnRequest; env?: NodeJS.ProcessEnv; installed?: string[] | null } = {},
) {
  const req = opts.req ?? request;
  let built: readonly string[] | null = null;
  const manifest = composeManifest({
    sessionId: 'session', request: req, context, launch: resolveLaunchConfig(req, context, opts.env ?? {}),
    workdir: { mode: 'project', path: '/repo' }, baseUrl: 'http://localhost', homeDir: HOME,
    agentConfigDir: `${HOME}/.claude`, now: new Date('2026-09-24T00:00:00Z'),
    command: (plugins) => { built = plugins; return `claude plugins=${plugins.join(',')}`; },
    ...(opts.installed === null ? {} : { harness: { installedPlugins: opts.installed ?? [] } }),
  });
  return { manifest, plugins: built as readonly string[] | null };
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
      allowed: [{ id: 'sales@synced', source: 'effective-skill' }],
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
      skillOverrides: { off: LANE_BUNDLED_SKILLS_OFF.map((name) => ({ name, source: 'builtin-trim' })) },
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
        selected: true,
        memoryVia: ['selection', 'selection'],
        selectionOnlySkillIds: ['picked'],
        dropped: [{ entityId: 'm-default', kind: 'memory', group: 'memories', reason: 'not-selected' }],
        legacyMemoriesDropped: 1,
      },
    });
    const { manifest } = compose(context, { req: { ...request, selection: { memoryIds: ['m1', 'm2'], skillIds: ['picked'] } } });
    const audit = manifest.context!;
    expect(audit.memoryIds).toEqual(['m1', 'm2']);
    expect(audit.groups).toEqual({
      memories: { mode: 'selected', legacyDropped: 1 },
      skills: { mode: 'selected' },
      references: { mode: 'default', reason: 'not-selectable', unread: 22 },
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
      references: { mode: 'default', reason: 'not-selectable' },
      teammates: { mode: 'default', reason: 'not-selectable' },
    });
    expect(manifest.context?.entries).toEqual([]);
    expect(manifest.context?.dropped).toEqual([]);
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
