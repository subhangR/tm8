// Exact selection at spawn, as execution sees it (design 01a0cb80 §5.2, §7.4).
//
// Execution never interprets Jev. It forwards `selection` to the graph loader,
// which resolves the exact sets, and it copies `jevRunId` onto the manifest.
// The audit it writes records what the selection left out (`not-selected`)
// and, afterwards, what the #646 byte budget dropped (`byte-budget`). Without
// either field, nothing it produces changes by a single byte.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PtyHostService } from '../src/pty/PtyHostService.js';
import { composeManifest, ECHO_AGENT_CMD, resolveLaunchConfig } from '../src/spawn/manifest.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import type { ResolvedSkillRow } from '../src/spawn/skills.js';
import type { SpawnContext, SpawnRequest } from '../src/spawn/types.js';
import { FakeGraph } from './fake-graph.js';

const RUN_ID = '99999999-9999-4999-8999-999999999999';
const SELECTION = {
  memoryIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
  skillIds: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
};

const context: SpawnContext = {
  spaceId: 'space', project: { id: 'project', name: 'repo', workingDir: '/repo', trust: 'trusted' }, tasks: [],
  teamMember: { id: 'persona', name: 'Persona', role: '', identity: '', memories: ['selected memory'], model: null, agentTool: null, mode: 'worker', permissionMode: null, avatar: null, capabilities: {}, commandPermissions: {} },
};

function compose(request: SpawnRequest, ctx: SpawnContext = context) {
  return composeManifest({
    sessionId: 'session', request, context: ctx, launch: resolveLaunchConfig(request, ctx, {}),
    workdir: { mode: 'project', path: '/repo' }, command: 'test', baseUrl: 'http://localhost', now: new Date('2026-09-23T00:00:00Z'),
  });
}

describe('manifest', () => {
  const base: SpawnRequest = { spaceId: 'space', teamMemberId: 'persona' };

  it('writes launch.jevRunId untouched — and nothing else changes', () => {
    const withRun = compose({ ...base, jevRunId: RUN_ID });
    expect(withRun.launch.jevRunId).toBe(RUN_ID);
    const { jevRunId: _dropped, ...launch } = withRun.launch;
    expect(JSON.stringify({ ...withRun, launch })).toBe(JSON.stringify(compose(base)));
  });

  it('absent jevRunId is ABSENT, not null — the baseline is byte-identical apart from the groups audit', () => {
    const manifest = compose(base);
    expect('jevRunId' in manifest.launch).toBe(false);
    const selected = compose({ ...base, selection: SELECTION });
    // The only differences a selection makes here: the recorded group mode,
    // and the selection itself on `launch` (which resume replays).
    expect(selected.context?.groups?.memories).toEqual({ mode: 'selected' });
    expect(manifest.context?.groups?.memories).toEqual({ mode: 'default', reason: 'no-selection' });
    expect(selected.launch.selection).toEqual(SELECTION);
    expect('selection' in manifest.launch).toBe(false);
    const withoutGroups = (m: typeof manifest) => JSON.stringify({
      ...m, launch: { ...m.launch, selection: null }, context: { ...m.context, groups: null },
    });
    expect(withoutGroups(selected)).toBe(withoutGroups(manifest));
  });

  it('audits the equipped skills a selection left out as not-selected; the byte budget still applies after', () => {
    const selected: ResolvedSkillRow[] = Array.from({ length: 400 }, (_, i) => ({
      entityId: `s${i}`, name: `selected-${i}`, depth: 0, description: `does thing ${i} `.repeat(8),
    }));
    const manifest = compose(base, {
      ...context,
      skillEquips: selected,
      skippedSkills: [{ entityId: 'left-out', name: 'equipped-but-unticked', reason: 'not-selected' }],
    });
    const reasons = manifest.effectiveSkills!.skipped.map((s) => [s.entityId, s.reason]);
    expect(reasons).toContainEqual(['left-out', 'not-selected']);
    expect(manifest.skills.map((s) => s.entityId)).not.toContain('left-out');
    // 400 selected entries overflow the 32 KiB index; the tail is budgeted out, and says so.
    const budgeted = manifest.effectiveSkills!.skipped.filter((s) => s.reason === 'byte-budget');
    expect(budgeted.length).toBeGreaterThan(0);
    expect(manifest.skills.length + budgeted.length).toBe(400);
    // Selection order is preserved: the budget drops from the END.
    expect(manifest.skills[0]?.entityId).toBe('s0');
  });
});

describe('manifest harnessChoice', () => {
  const base: SpawnRequest = { spaceId: 'space', teamMemberId: 'persona' };
  it('is written only when the launch picked a harness', () => {
    expect('harnessChoice' in compose(base).launch).toBe(false);
    expect(compose({ ...base, harnessSurface: 'minimal', plugins: ['sales'] }).launch.harnessChoice)
      .toEqual({ surface: 'minimal', plugins: ['sales'] });
    // A plugin pick under `inherit` does nothing, so only the surface is recorded.
    expect(compose({ ...base, harnessSurface: 'inherit', plugins: ['sales'] }).launch.harnessChoice)
      .toEqual({ surface: 'inherit' });
  });
});

describe('SpawnService', () => {
  let dataDir: string;
  let projectDir: string;
  let graph: FakeGraph;
  let pty: PtyHostService;
  const REQUEST = {
    clientMutationId: 'mutation-1',
    spaceId: '11111111-1111-4111-8111-111111111111',
    teamMemberId: '22222222-2222-4222-8222-222222222222',
    projectId: '33333333-3333-4333-8333-333333333333',
    taskIds: ['44444444-4444-4444-8444-444444444444'],
  };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-sel-data-'));
    projectDir = await mkdtemp(join(tmpdir(), 'tm8-sel-project-'));
    graph = new FakeGraph({ workingDir: projectDir, memories: ['m'] });
    pty = new PtyHostService();
    vi.spyOn(pty, 'beginPromptHandoff').mockImplementation(() => {});
    vi.spyOn(pty, 'spawnIfAbsent').mockReturnValue({ reused: false } as never);
    vi.spyOn(pty, 'waitForBootSettlement').mockResolvedValue(null);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  const service = () => new SpawnService({
    graph, pty, baseUrl: 'http://127.0.0.1:4611', dataDir,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TM8_AGENT_CMD: ECHO_AGENT_CMD },
    bootSettlementMs: 25,
  });

  it('hands selection to the graph loader, which resolves the exact sets', async () => {
    await service().spawn({ identityId: 'i' }, { ...REQUEST, selection: SELECTION, jevRunId: RUN_ID });
    expect(graph.spawnContextInputs[0]?.selection).toEqual(SELECTION);
    expect(graph.manifests[0]?.manifest.launch.jevRunId).toBe(RUN_ID);
  });

  // A minimal claude lane allowlists the plugins its equipped plugin skills live
  // in. Under a selection the loader's equip set IS the selection, so Jev's
  // picks decide which plugins come back — not the persona's standing equips.
  describe('plugin allowlist follows the selection', () => {
    const SALES_SKILL: ResolvedSkillRow = {
      entityId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'call-prep', depth: 0, description: '',
      provider: 'claude', level: 'plugin', loaderMetadata: { pluginName: 'sales', enabled: true },
    };
    let lastLaunch: Record<string, unknown> = {};
    async function claudeLaunch(options: { skillEquips: ResolvedSkillRow[]; skippedSkills?: SpawnContext['skippedSkills'] }) {
      const configDir = join(dataDir, 'claude-home');
      await mkdir(join(configDir, 'plugins', 'synced', 'bucket'), { recursive: true });
      await writeFile(
        join(configDir, 'plugins', 'synced', 'bucket', 'manifest.json'),
        JSON.stringify({ plugins: [{ name: 'sales' }, { name: 'marketing' }] }),
      );
      await mkdir(join(configDir, 'skills', 'astro'), { recursive: true });
      await writeFile(join(configDir, 'skills', 'astro', 'SKILL.md'), '---\nname: astro\n---\n');
      // A stub `claude` on PATH: the spawn preflight only checks it exists, and
      // CI has no real one. The PTY is mocked, so it never runs.
      const binDir = join(dataDir, 'bin');
      await mkdir(binDir, { recursive: true });
      await writeFile(join(binDir, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      graph = new FakeGraph({ workingDir: projectDir, ...options });
      await new SpawnService({
        graph, pty, baseUrl: 'http://127.0.0.1:4611', dataDir,
        env: { PATH: `${binDir}:${process.env.PATH ?? ''}`, HOME: process.env.HOME, CLAUDE_CONFIG_DIR: configDir },
        bootSettlementMs: 25,
      }).spawn({ identityId: 'i' }, { ...REQUEST, selection: SELECTION });
      lastLaunch = graph.manifests[0]!.manifest.launch as Record<string, unknown>;
      return graph.manifests[0]!.manifest.launch.command;
    }

    it('a selection that leaves an equipped plugin skill unticked keeps its plugin off', async () => {
      const command = await claudeLaunch({
        skillEquips: [],
        skippedSkills: [{ entityId: SALES_SKILL.entityId, name: SALES_SKILL.name, reason: 'not-selected' }],
      });
      expect(command).toContain('"sales@synced":false');
      expect(command).toContain('"marketing@synced":false');
    });

    it('a project skill sharing an operator skill\'s name keeps it listed: the key would reach both', async () => {
      await mkdir(join(projectDir, '.claude', 'skills', 'astro'), { recursive: true });
      await writeFile(join(projectDir, '.claude', 'skills', 'astro', 'SKILL.md'), '---\nname: astro\n---\n');
      const command = await claudeLaunch({ skillEquips: [] });
      expect(command).not.toContain('"astro":"off"');
      expect(lastLaunch.harness).toMatchObject({ skillOverrides: { kept: [{ name: 'astro', because: 'project-collision' }] } });
    });

    it('a selected plugin skill, equipped or not, turns its plugin on', async () => {
      const command = await claudeLaunch({ skillEquips: [SALES_SKILL] });
      expect(command).toContain('"sales@synced":true');
      expect(command).toContain('"marketing@synced":false');
      // The manifest records every plugin's fate, and it agrees with the argv.
      expect(lastLaunch.harness).toMatchObject({
        surface: 'minimal',
        surfaceSource: 'default',
        plugins: {
          allowed: [{ id: 'sales@synced', source: 'effective-skill', granularity: 'plugin' }],
          denied: [{ id: 'marketing@synced', because: 'not-chosen' }],
        },
        mcpServers: [],
      });
      // The operator skill nobody chose is off, and the Chrome block with it.
      expect(command).toContain('"astro":"off"');
      expect(command).toContain('--no-chrome');
      expect(lastLaunch.harness).toMatchObject({
        skillOverrides: { off: expect.arrayContaining([{ name: 'astro', source: 'user-unselected' }]) },
      });
    });
  });

  it('without selection the loader input carries no selection key at all', async () => {
    await service().spawn({ identityId: 'i' }, REQUEST);
    expect(Object.keys(graph.spawnContextInputs[0] ?? {}).sort()).toEqual(
      ['parentSessionId', 'projectId', 'spaceId', 'taskIds', 'teamMemberId'],
    );
    expect('jevRunId' in (graph.manifests[0]?.manifest.launch ?? {})).toBe(false);
  });
});
