// Tools v2 PR-E (design doc 01a182cb §5): the launch `<context_index>` gains a
// `tools` group — the space's tools, read under RLS through the graph port,
// most recently run first then by name, at most TOOL_INDEX_READ_MAX, each with
// its selection header as untrusted data and `tm8 tool help <name>` as its
// pointer; the rest declared with `tm8 tool list`. Emitted only when the space
// has tools, trimmed like references, and the first group to give way.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BYTE_BUDGETS,
  composePrompt,
  serializeContextGroup,
  serializeContextIndex,
  utf8Bytes,
  type PromptContextGroup,
} from '@tm8/prompt';
import type { SelectionHeader } from '@tm8/contract';
import { PtyHostService } from '../src/pty/PtyHostService.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import {
  contextHeaderIds,
  contextIndexCandidates,
  fitLaunchContextIndex,
  TOOL_INDEX_FETCH,
  TOOL_INDEX_READ_MAX,
  toolIndexEntry,
} from '../src/spawn/context-index.js';
import { composeManifest, resolveLaunchConfig } from '../src/spawn/manifest.js';
import type { GraphAuth, SpaceTools, SpawnContext, SpawnRequest, TaskContext } from '../src/spawn/types.js';
import { FakeGraph } from './fake-graph.js';

const URL_CHECK = '01a18300-0000-7000-8000-000000000001';
const GH_PR = '01a18300-0000-7000-8000-000000000002';

const toolHeader = (id: string, name: string, extra: Partial<SelectionHeader> = {}): SelectionHeader => ({
  entityId: id, kind: 'tool', name, whenToUse: `Open when you need ${name}`, summary: `${name} summary`, keywords: [],
  source: 'authored', stale: false, bytes: 2048, loadPointer: `tm8 entity context ${id}`, ...extra,
});

const request: SpawnRequest = { spaceId: 'space', teamMemberId: 'persona' };
const member: SpawnContext['teamMember'] = {
  id: 'persona', name: 'Persona', role: '', identity: '', memories: [], model: null, agentTool: 'claude-code',
  mode: 'worker', permissionMode: null, avatar: null, capabilities: {}, commandPermissions: {},
};
const task = (extra: Partial<TaskContext> = {}): TaskContext => ({
  id: 'task-1', version: 1, title: 'Build it', description: 'Do the thing.', priority: 'medium', status: 'open',
  acceptanceCriteria: [], ...extra,
});
const ctx = (extra: Partial<SpawnContext> = {}): SpawnContext => ({
  spaceId: 'space', project: { id: 'project', name: 'repo', workingDir: '/repo', trust: 'trusted' },
  tasks: [task()], teamMember: member, ...extra,
});
const twoTools = (total = 2): SpaceTools => ({
  tools: [{ entityId: URL_CHECK, name: 'url-check' }, { entityId: GH_PR, name: 'gh-pr-status' }],
  total,
});

function compose(context: SpawnContext) {
  const manifest = composeManifest({
    sessionId: 'session', request, context, launch: resolveLaunchConfig(request, context, {}),
    workdir: { mode: 'project', path: '/repo' }, baseUrl: 'http://localhost', homeDir: '/home/test',
    agentConfigDir: '/home/test/.claude', now: new Date('2026-10-28T00:00:00Z'),
    command: (plugins) => `claude plugins=${plugins.join(',')}`,
    contextIndex: { source: 'default' },
  });
  return { manifest, prompt: composePrompt(manifest, { sessionId: 'session', baseUrl: 'http://localhost' }) };
}

describe('the tools group: candidates', () => {
  it('is the last group, each tool pointed at its help by name, its header as untrusted text, and no misstated bytes', () => {
    const headers = [toolHeader(URL_CHECK, 'url-check'), toolHeader(GH_PR, 'gh-pr-status', { source: 'derived', whenToUse: null, summary: 'Lists PRs' })];
    const groups = contextIndexCandidates({ context: ctx({ tools: twoTools(5), headers }), skills: [] });
    expect(groups.map((g) => g.name)).toEqual(['memories', 'references', 'teammates', 'skills', 'tools']);
    expect(groups.at(-1)).toEqual({
      name: 'tools',
      omitted: 3,
      fetch: TOOL_INDEX_FETCH,
      entries: [
        { id: URL_CHECK, kind: 'tool', via: 'space', load: 'tm8 tool help url-check', source: 'authored', stale: false,
          header: { name: 'url-check', whenToUse: 'Open when you need url-check', summary: 'url-check summary' } },
        { id: GH_PR, kind: 'tool', via: 'space', load: 'tm8 tool help gh-pr-status', source: 'derived', stale: false,
          header: { name: 'gh-pr-status', whenToUse: null, summary: 'Lists PRs' } },
      ],
    });
    expect(TOOL_INDEX_FETCH).toBe('tm8 tool list');
    expect(TOOL_INDEX_READ_MAX).toBe(8);
  });

  it('names a tool whose header did not resolve by its own name', () => {
    expect(toolIndexEntry({ entityId: URL_CHECK, name: 'url-check' }, undefined)).toEqual({
      id: URL_CHECK, kind: 'tool', via: 'space', load: 'tm8 tool help url-check', header: { name: 'url-check' },
    });
  });

  it('is absent when the space has no tools, or the launch read none', () => {
    expect(contextIndexCandidates({ context: ctx(), skills: [] }).map((g) => g.name)).not.toContain('tools');
    expect(contextIndexCandidates({ context: ctx({ tools: { tools: [], total: 0 } }), skills: [] }).map((g) => g.name)).not.toContain('tools');
  });

  it('asks the one header read for every tool it lists', () => {
    expect(contextHeaderIds(ctx({ tools: twoTools() }))).toEqual(expect.arrayContaining([URL_CHECK, GH_PR]));
  });
});

describe('the tools group: composed into the launch manifest and prompt', () => {
  it('renders after skills inside <context_index>, with the load pointers and headers, and the audit records it', () => {
    const { manifest, prompt } = compose(ctx({ tools: twoTools(9), headers: [toolHeader(URL_CHECK, 'url-check'), toolHeader(GH_PR, 'gh-pr-status')] }));
    const group = manifest.contextIndex!.groups.find((g) => g.name === 'tools')!;
    expect(group.entries.map((e) => e.id)).toEqual([URL_CHECK, GH_PR]);
    expect(group.omitted).toBe(7);
    expect(prompt.system).toContain(serializeContextGroup(group));
    expect(prompt.system).toContain('<group name="tools" count="2" omitted="7" fetch="tm8 tool list">');
    expect(prompt.system).toContain('load="tm8 tool help url-check"');
    expect(prompt.system).toMatch(/kind="tool" via="space"[^>]*>\n<untrusted_data type="entry-header" encoding="escaped-json"[^>]*>\n\{&quot;name&quot;:&quot;url-check&quot;,&quot;whenToUse&quot;:&quot;Open when you need url-check&quot;/);
    expect(manifest.context!.index!.caps).toContainEqual({ groups: ['tools'], cap: BYTE_BUDGETS.toolIndex });
    expect(manifest.context!.groups!.tools).toEqual({ mode: 'default', reason: 'not-selectable', unread: 7 });
    expect(manifest.context!.entries!.filter((e) => e.group === 'tools')).toEqual([
      expect.objectContaining({ entityId: URL_CHECK, kind: 'tool', via: 'space', rank: 1, state: 'collapsed' }),
      expect.objectContaining({ entityId: GH_PR, kind: 'tool', via: 'space', rank: 2, state: 'collapsed' }),
    ]);
  });

  it('a space with no tools composes exactly as before: no group, no tools audit', () => {
    const { manifest, prompt } = compose(ctx({ tools: { tools: [], total: 0 } }));
    expect(manifest.contextIndex!.groups.map((g) => g.name)).not.toContain('tools');
    expect(prompt.system).not.toContain('name="tools"');
    expect(manifest.context!.groups!.tools).toEqual({ mode: 'default', reason: 'not-selectable' });
    const { manifest: unread } = compose(ctx());
    expect(unread.context!.groups!.tools).toBeUndefined();
  });
});

describe('the tools group: the launch trim', () => {
  const groups = (): PromptContextGroup[] => contextIndexCandidates({
    context: ctx({
      tools: twoTools(),
      headers: [toolHeader(URL_CHECK, 'url-check'), toolHeader(GH_PR, 'gh-pr-status')],
      tasks: [task({ linked: [{ entityId: 'doc-1', kind: 'doc', link: 'relates_to', title: 'Doc one' }], linkedTotal: 1 })],
    }),
    skills: [],
  });

  it('gives way first: short of room, every tool goes before any reference, declared with tm8 tool list', () => {
    const candidates = groups();
    const referencesOnly = candidates.map((g) => (g.name === 'tools' ? { ...g, entries: [], omitted: 2 } : g));
    // Room for the reference and the tools group's declaration only: the
    // minimums give way, the space's tools first.
    const available = utf8Bytes(serializeContextIndex({ groups: referencesOnly })) + 1;
    const fit = fitLaunchContextIndex({ candidates, mode: 'worker', budgets: {}, available });
    expect(fit.index.groups.find((g) => g.name === 'references')!.entries.map((e) => e.id)).toEqual(['doc-1']);
    const tools = fit.index.groups.find((g) => g.name === 'tools')!;
    expect(tools.entries).toEqual([]);
    expect(tools.omitted).toBe(2);
    expect(fit.drops.filter((d) => d.group === 'tools').map((d) => [d.id, d.level])).toEqual([[GH_PR, 'entry'], [URL_CHECK, 'entry']]);
    expect(serializeContextIndex(fit.index)).toContain('<group name="tools" count="0" omitted="2" fetch="tm8 tool list">');
  });

  it('keeps every tool when there is room', () => {
    const fit = fitLaunchContextIndex({ candidates: groups(), mode: 'worker', budgets: {}, available: BYTE_BUDGETS.combinedInitialInjection });
    expect(fit.index.groups.find((g) => g.name === 'tools')!.entries.map((e) => e.id)).toEqual([URL_CHECK, GH_PR]);
    expect(fit.drops).toEqual([]);
  });
});

const SPACE_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const AUTH = { identityId: 'identity-1', actorId: 'actor-1' };

class ToolsGraph extends FakeGraph {
  readonly toolReads: Array<{ spaceId: string; limit: number }> = [];
  readonly headerReads: string[][] = [];
  failTools = false;

  async loadSpaceTools(_auth: GraphAuth, input: { spaceId: string; limit: number }): Promise<SpaceTools> {
    this.toolReads.push(input);
    if (this.failTools) throw new Error('tools read failed');
    return twoTools(3);
  }

  async loadContextHeaders(_auth: GraphAuth, input: { spaceId: string; ids: string[] }): Promise<SelectionHeader[]> {
    this.headerReads.push(input.ids);
    return input.ids.filter((id) => id === URL_CHECK).map((id) => toolHeader(id, 'url-check'));
  }
}

describe('SpawnService reads the space\'s tools for every launch', () => {
  let dataDir: string;
  let projectDir: string;
  let pty: PtyHostService;
  let graph: ToolsGraph;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-tools-data-'));
    projectDir = await mkdtemp(join(tmpdir(), 'tm8-tools-proj-'));
    graph = new ToolsGraph({ workingDir: projectDir });
    pty = new PtyHostService();
  });

  afterEach(async () => {
    pty.shutdownAll();
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  const service = (): SpawnService => new SpawnService({
    graph, pty, baseUrl: 'http://127.0.0.1:4615', dataDir, nodeId: 'test-node',
    env: { ...process.env, TM8_AGENT_CMD: 'echo-agent' },
  });

  it('reads at most TOOL_INDEX_READ_MAX tools, their headers ride the one header read, and the manifest carries the group', async () => {
    const result = await service().spawn(AUTH, { spaceId: SPACE_ID, teamMemberId: MEMBER_ID, mode: 'worker' });
    expect(graph.toolReads).toEqual([{ spaceId: SPACE_ID, limit: TOOL_INDEX_READ_MAX }]);
    expect(graph.headerReads).toHaveLength(1);
    expect(graph.headerReads[0]).toEqual(expect.arrayContaining([URL_CHECK, GH_PR]));
    const group = result.manifest.contextIndex!.groups.find((g) => g.name === 'tools')!;
    expect(group).toMatchObject({ omitted: 1, fetch: 'tm8 tool list' });
    expect(group.entries).toMatchObject([
      { id: URL_CHECK, via: 'space', load: 'tm8 tool help url-check', source: 'authored', header: { whenToUse: 'Open when you need url-check' } },
      { id: GH_PR, via: 'space', load: 'tm8 tool help gh-pr-status', header: { name: 'gh-pr-status' } },
    ]);
  });

  it('a dispatcher gets the group too', async () => {
    const result = await service().spawn(AUTH, { spaceId: SPACE_ID, teamMemberId: MEMBER_ID, mode: 'dispatcher' });
    expect(result.manifest.contextIndex!.groups.map((g) => g.name)).toContain('tools');
  });

  it('a failed tools read costs the prompt its tools group, never the launch', async () => {
    graph.failTools = true;
    const result = await service().spawn(AUTH, { spaceId: SPACE_ID, teamMemberId: MEMBER_ID, mode: 'worker' });
    expect(result.sessionId).toBeTruthy();
    expect(result.manifest.contextIndex!.groups.map((g) => g.name)).not.toContain('tools');
    expect(result.manifest.context!.groups!.tools).toBeUndefined();
  });
});
