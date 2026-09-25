// I5 — the unified `<context_index>` (design 01a0d348 §2, §4.1), shipped dark.

import { describe, expect, it } from 'vitest';
import {
  BYTE_BUDGETS,
  composePrompt,
  contextEntryBytes,
  serializeContextIndex,
  utf8Bytes,
} from '@tm8/prompt';
import type { SelectionHeader } from '@tm8/contract';
import { contextIndexForResume, contextIndexSwitch } from '../src/spawn/context-index.js';
import { composeManifest, resolveLaunchConfig } from '../src/spawn/manifest.js';
import type { ResolvedSkillRow } from '../src/spawn/skills.js';
import type { SpawnContext, SpawnRequest, TaskContext } from '../src/spawn/types.js';

const HOME = '/home/test';
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
const skillRow = (i: number, extra: Partial<ResolvedSkillRow> = {}): ResolvedSkillRow => ({
  entityId: `s${i}`, name: `skill-${i}`, depth: 0, description: `does thing ${i} `.repeat(8), ...extra,
});
const docHeader = (id: string, summary = 'a summary '.repeat(40)): SelectionHeader => ({
  entityId: id, kind: 'doc', name: `Doc ${id}`, whenToUse: `open ${id} when designing`, summary, keywords: [],
  source: 'derived', stale: false, bytes: 4096, loadPointer: `tm8 entity context ${id}`,
});

function compose(context: SpawnContext, opts: { on?: boolean; replay?: string[]; installed?: string[] } = {}) {
  const manifest = composeManifest({
    sessionId: 'session', request, context, launch: resolveLaunchConfig(request, context, {}),
    workdir: { mode: 'project', path: '/repo' }, baseUrl: 'http://localhost', homeDir: HOME,
    agentConfigDir: `${HOME}/.claude`, now: new Date('2026-09-24T00:00:00Z'),
    command: (plugins) => `claude plugins=${plugins.join(',')}`,
    ...(opts.on ? { contextIndex: { source: 'env' as const } } : {}),
    ...(opts.replay ? { replayEffectivePlugins: opts.replay } : {}),
    ...(opts.installed ? { harness: { installedPlugins: opts.installed } } : {}),
  });
  const prompt = composePrompt(manifest, { sessionId: 'session', baseUrl: 'http://localhost' });
  return { manifest, prompt };
}

describe('the switch (§10 Q2: default off)', () => {
  it('is off unless the env or the pinned profile turns it on; the env outranks the profile', () => {
    expect(contextIndexSwitch({}, null)).toEqual({ on: false });
    expect(contextIndexSwitch({}, { draft: { contextIndex: false } })).toEqual({ on: false });
    expect(contextIndexSwitch({}, { draft: { contextIndex: true } })).toEqual({ on: true, source: 'profile' });
    expect(contextIndexSwitch({ TM8_CONTEXT_INDEX: 'on' }, null)).toEqual({ on: true, source: 'env' });
    expect(contextIndexSwitch({ TM8_CONTEXT_INDEX: '0' }, { draft: { contextIndex: true } })).toEqual({ on: false });
  });

  it('a resume replays the launch\'s index, unless the node env now turns it off', () => {
    expect(contextIndexForResume({}, 'profile')).toEqual({ source: 'profile' });
    expect(contextIndexForResume({}, null)).toBeNull();
    expect(contextIndexForResume({ TM8_CONTEXT_INDEX: 'off' }, 'env')).toBeNull();
    expect(contextIndexForResume({ TM8_CONTEXT_INDEX: 'on' }, null)).toBeNull();
  });

  it('off: the manifest carries no index and the prompt keeps <skills>', () => {
    const { manifest, prompt } = compose(ctx({ skillEquips: [skillRow(1)] }));
    expect(manifest.contextIndex).toBeUndefined();
    expect(manifest.context?.index).toBeUndefined();
    expect(prompt.system).toContain('<skills>');
    expect(prompt.system).not.toContain('<context_index');
  });
});

describe('on: one index for skills, references and teammates', () => {
  const linked = [
    { entityId: 'doc-1', kind: 'doc', link: 'relates_to', title: 'Doc one' },
    { entityId: 'mate-1', kind: 'team_member', link: 'relates_to', title: 'Mate' },
    { entityId: 'persona', kind: 'team_member', link: 'relates_to', title: 'Self' },
    { entityId: 'ws-1', kind: 'work_session', link: 'relates_to', title: null },
  ];
  const context = ctx({
    tasks: [task({ linked, linkedTotal: linked.length, attachments: [{ fileEntityId: 'file-1', name: 'spec.pdf', mime: 'application/pdf' }] })],
    skillEquips: [skillRow(1)],
    headers: [docHeader('doc-1')],
  });

  it('renders the groups with headers inside untrusted_data and load pointers from loadPointerFor', () => {
    const { manifest, prompt } = compose(context, { on: true });
    expect(prompt.system).toContain(serializeContextIndex(manifest.contextIndex!));
    expect(prompt.system).not.toContain('<skills>');
    const names = manifest.contextIndex!.groups.map((g) => [g.name, g.entries.map((e) => e.id)]);
    expect(names).toEqual([
      ['references', ['doc-1', 'ws-1', 'file-1']],
      ['teammates', ['mate-1']],
      ['skills', ['s1']],
    ]);
    expect(prompt.system).toContain('load="tm8 entity context doc-1"');
    expect(prompt.system).toContain('load="tm8 entity context s1"');
    expect(manifest.context?.index).toMatchObject({ source: 'env', caps: [{ groups: ['references', 'teammates'], cap: BYTE_BUDGETS.referenceIndex }] });
  });

  it('records each entry at the bytes the prompt renders, and the index bytes exactly', () => {
    const { manifest } = compose(context, { on: true });
    const rendered = new Map(manifest.contextIndex!.groups.flatMap((g) => g.entries.map((e) => [e.id, contextEntryBytes(e)])));
    for (const entry of manifest.context!.entries!.filter((e) => e.group !== 'memories')) {
      expect(entry.bytes).toBe(rendered.get(entry.entityId));
    }
    expect(manifest.context!.index!.bytes).toBe(utf8Bytes(serializeContextIndex(manifest.contextIndex!)) + 1);
  });
});

describe('on: the trim records every drop (§2.3)', () => {
  it('references over their 8 KiB sub-cap lose header text first, then whole entries — all recorded', () => {
    const linked = Array.from({ length: 60 }, (_, i) => ({ entityId: `doc-${i}`, kind: 'doc', link: 'relates_to', title: `Doc ${i}` }));
    const { manifest, prompt } = compose(ctx({
      tasks: [task({ linked, linkedTotal: linked.length })],
      headers: linked.map((l) => docHeader(l.entityId)),
    }), { on: true });
    const group = manifest.contextIndex!.groups.find((g) => g.name === 'references')!;
    expect(group.omitted).toBeGreaterThan(0);
    const dropped = manifest.context!.dropped!.filter((d) => d.group === 'references' && d.reason === 'byte-budget');
    expect(dropped.filter((d) => d.level === 'entry')).toHaveLength(group.omitted);
    expect(dropped.filter((d) => d.level === 'header').length)
      .toBe(group.entries.filter((e) => e.headerDropped).length);
    const states = manifest.context!.entries!.filter((e) => e.group === 'references').map((e) => e.state);
    expect(states).toContain('header-dropped');
    expect(prompt.system).toContain(`omitted="${group.omitted}" fetch="tm8 entity context task-1 --sections connections"`);
  });

  it('skills take what remains: a whole-entry skill drop is byte-budget in every record', () => {
    const rows = Array.from({ length: 400 }, (_, i) => skillRow(i));
    const { manifest, prompt } = compose(ctx({ skillEquips: rows }), { on: true });
    const skills = manifest.contextIndex!.groups.find((g) => g.name === 'skills')!;
    expect(skills.omitted).toBeGreaterThan(0);
    expect(manifest.skills).toHaveLength(skills.entries.length);
    expect(manifest.droppedSkills).toHaveLength(skills.omitted);
    expect(manifest.effectiveSkills!.skipped.filter((s) => s.reason === 'byte-budget')).toHaveLength(skills.omitted);
    const drops = manifest.context!.dropped!.filter((d) => d.group === 'skills' && d.reason === 'byte-budget');
    expect(drops.filter((d) => d.level === 'entry')).toHaveLength(skills.omitted);
    expect(drops.filter((d) => d.level === 'header')).toHaveLength(skills.entries.filter((e) => e.headerDropped).length);
    expect(utf8Bytes(`${prompt.system}\n\n${prompt.task}`)).toBeLessThanOrEqual(BYTE_BUDGETS.combinedInitialInjection);
  });
});

describe('on: I6 selected references (the #759 seam)', () => {
  const linked = [
    { entityId: 'doc-kept', kind: 'doc', link: 'relates_to', title: 'Kept' },
    { entityId: 'mate-1', kind: 'team_member', link: 'relates_to', title: 'Mate' },
    { entityId: 'ws-1', kind: 'work_session', link: 'relates_to', title: null },
  ];
  const selected = (references: NonNullable<SpawnContext['references']>, extra: Partial<SpawnContext> = {}) => ctx({
    tasks: [task({
      linked: [...linked, { entityId: 'doc-unticked', kind: 'doc', link: 'relates_to', title: 'Unticked' }],
      linkedTotal: linked.length + 1,
      attachments: [{ fileEntityId: 'file-unticked', name: 'a.txt', mime: 'text/plain' }],
    })],
    references,
    contextAudit: {
      selectedGroups: ['references'],
      memoryVia: [],
      dropped: [
        { entityId: 'doc-unticked', kind: 'doc', group: 'references', reason: 'not-selected' },
        { entityId: 'file-unticked', kind: 'file', group: 'references', reason: 'not-selected' },
      ],
    },
    ...extra,
  });

  it('renders the exact selected set in its order, not the defaults, and a rendered selection-only id is no longer not-rendered', () => {
    const { manifest, prompt } = compose(selected([
      { entityId: 'art-pick', kind: 'artifact', title: 'Picked', via: 'selection' },
      { entityId: 'doc-kept', kind: 'doc', title: 'Kept', via: 'linked', link: 'relates_to' },
    ], { headers: [docHeader('art-pick')] }), { on: true });
    const groups = new Map(manifest.contextIndex!.groups.map((g) => [g.name, g.entries]));
    // Selected references lead, in the selected order; a linked row of a kind
    // selection cannot name (the work session) still comes from the task.
    expect(groups.get('references')!.map((e) => [e.id, e.via])).toEqual([
      ['art-pick', 'selection'],
      ['doc-kept', 'linked'],
      ['ws-1', 'linked'],
    ]);
    expect(groups.get('teammates')!.map((e) => e.id)).toEqual(['mate-1']);
    expect(prompt.system).toContain('load="tm8 entity context art-pick"');
    expect(prompt.system).not.toContain('doc-unticked');
    const refs = manifest.context!.entries!.filter((e) => e.group === 'references').map((e) => [e.entityId, e.via]);
    expect(refs).toEqual([['art-pick', 'selection'], ['doc-kept', 'linked'], ['ws-1', 'linked']]);
    expect(manifest.context!.dropped).toEqual([
      { entityId: 'doc-unticked', kind: 'doc', group: 'references', reason: 'not-selected' },
      { entityId: 'file-unticked', kind: 'file', group: 'references', reason: 'not-selected' },
    ]);
  });

  it('a selected reference the trim drops is byte-budget only, never also not-rendered', () => {
    const picks = Array.from({ length: 60 }, (_, i) => ({ entityId: `art-${i}`, kind: 'artifact', title: `Art ${i}`, via: 'selection' as const }));
    const { manifest } = compose(selected(picks, { headers: picks.map((p) => docHeader(p.entityId)) }), { on: true });
    const group = manifest.contextIndex!.groups.find((g) => g.name === 'references')!;
    expect(group.omitted).toBeGreaterThan(0);
    const drops = manifest.context!.dropped!;
    expect(drops.filter((d) => d.reason === 'not-rendered')).toEqual([]);
    const keys = drops.filter((d) => d.level === 'entry').map((d) => `${d.group}:${d.entityId}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(drops.filter((d) => d.group === 'references' && d.reason === 'byte-budget' && d.level === 'entry')).toHaveLength(group.omitted);
  });
});

describe('carry-overs from #741', () => {
  it('(b) a skill skipped as missing is recorded in context.dropped', () => {
    const { manifest } = compose(ctx({ skillEquips: [skillRow(1, { missing: true } as Partial<ResolvedSkillRow>)] }));
    expect(manifest.effectiveSkills!.skipped).toEqual([expect.objectContaining({ entityId: 's1', reason: 'missing' })]);
    expect(manifest.context!.dropped).toContainEqual({ entityId: 's1', kind: 'skill', group: 'skills', reason: 'missing' });
  });

  it('(a) a resume replays the launch\'s effective-skill plugins instead of re-deriving them', () => {
    const { manifest } = compose(ctx(), { replay: ['sales'], installed: ['marketing@synced', 'sales@synced'] });
    expect(manifest.launch.command).toBe('claude plugins=sales');
    expect(manifest.launch.harness?.plugins?.allowed).toEqual([{ id: 'sales@synced', source: 'effective-skill' }]);
  });
});
