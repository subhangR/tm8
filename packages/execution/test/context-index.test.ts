// I5 — the unified `<context_index>` (design 01a0d348 §2, §4.1), shipped dark.

import { describe, expect, it } from 'vitest';
import {
  BYTE_BUDGETS,
  composePrompt,
  contextEntryBytes,
  INDEX_DERIVED_HEADER_CHARS,
  serializeContextIndex,
  untrustedData,
  utf8Bytes,
} from '@tm8/prompt';
import type { SelectionHeader } from '@tm8/contract';
import { collapseMemories, contextBudgetsFrom, contextIndexCaps, contextIndexForResume, contextIndexSwitch } from '../src/spawn/context-index.js';
import { composeManifest, resolveLaunchConfig } from '../src/spawn/manifest.js';
import type { ResolvedSkillRow } from '../src/spawn/skills.js';
import type { ContextVia, SpawnContext, SpawnRequest, TaskContext } from '../src/spawn/types.js';

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
    const names = manifest.contextIndex!.groups.filter((g) => g.entries.length > 0).map((g) => [g.name, g.entries.map((e) => e.id)]);
    expect(names).toEqual([
      ['references', ['doc-1', 'ws-1', 'file-1']],
      ['teammates', ['mate-1']],
      ['skills', ['s1']],
    ]);
    expect(prompt.system).toContain('load="tm8 entity context doc-1"');
    expect(prompt.system).toContain('load="tm8 entity context s1"');
    expect(manifest.context?.index).toMatchObject({ source: 'env' });
    expect(manifest.context?.index?.caps).toContainEqual({ groups: ['references', 'teammates'], cap: BYTE_BUDGETS.referenceIndex });
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
    expect(manifest.launch.harness?.plugins?.allowed).toEqual([{ id: 'sales@synced', source: 'effective-skill', granularity: 'plugin' }]);
  });
});

describe('I5a follow-ups (a) (b) (d): no repeated titles, unread declared, derived text cut short', () => {
  const linked = [
    { entityId: 'doc-1', kind: 'doc', link: 'relates_to', title: 'Doc one' },
    { entityId: 'doc-2', kind: 'doc', link: 'relates_to', title: 'Doc two' },
  ];
  const long = 'derived text '.repeat(40); // 520 chars
  const context = ctx({
    tasks: [task({ linked, linkedTotal: 46 })],
    headers: [
      docHeader('doc-1', long),
      { ...docHeader('doc-2', long), source: 'authored', whenToUse: 'w'.repeat(300), clipped: ['keywords', 'whenToUse'] },
    ],
  });

  it('(d) cuts a DERIVED header to INDEX_DERIVED_HEADER_CHARS per field and declares it; authored text is untouched', () => {
    const { manifest, prompt } = compose(context, { on: true });
    const refs = manifest.contextIndex!.groups.find((g) => g.name === 'references')!;
    const derived = refs.entries.find((e) => e.id === 'doc-1')!;
    expect(Array.from(derived.header!.summary!)).toHaveLength(INDEX_DERIVED_HEADER_CHARS);
    expect(derived.header!.summary!.endsWith('…')).toBe(true);
    expect(derived.clipped).toEqual(['summary']);
    const authored = refs.entries.find((e) => e.id === 'doc-2')!;
    expect(authored.header!.summary).toBe(long);
    expect(authored.header!.whenToUse).toBe('w'.repeat(300));
    // An authored clip already declared by resolveHeaders is carried, not
    // re-cut; `keywords` is not text the index shows, so it is not named.
    expect(authored.clipped).toEqual(['whenToUse']);
    expect(prompt.system).toContain('clipped="summary"');
    expect(prompt.system).toContain('clipped="whenToUse"');
    expect(prompt.system).not.toContain('keywords');
  });

  it('(d) redacts a credential BEFORE the cut, so a cut through one never ships its prefix', () => {
    // The token starts inside the 200 kept characters and ends past them: cut
    // first, `sk-` plus 12 characters is too short for the pattern.
    const secret = `${'a'.repeat(183)} sk-${'Z'.repeat(40)} tail`;
    const { manifest, prompt } = compose(ctx({
      tasks: [task({ linked: [linked[0]!], linkedTotal: 1 })],
      headers: [{ ...docHeader('doc-1', secret), whenToUse: secret }],
    }), { on: true });
    const entry = manifest.contextIndex!.groups.find((g) => g.name === 'references')!.entries[0]!;
    expect(entry.header!.summary).toBe(`${'a'.repeat(183)} [credential-red…`);
    expect(entry.header!.whenToUse).toBe(entry.header!.summary);
    expect(entry.clipped).toEqual(['summary', 'whenToUse']);
    expect(prompt.system).not.toContain('sk-Z');
  });

  it('(b) links past the spawn read are the references group\'s omitted count, with the command that lists them', () => {
    const { manifest, prompt } = compose(context, { on: true });
    const refs = manifest.contextIndex!.groups.find((g) => g.name === 'references')!;
    expect(refs.omitted).toBe(44);
    expect(refs.fetch).toBe('tm8 entity context task-1 --sections connections');
    expect(prompt.system).toContain('<group name="references" count="2" omitted="44" fetch="tm8 entity context task-1 --sections connections">');
    // The audit keeps recording the same number.
    expect(manifest.context!.groups.references).toMatchObject({ unread: 44 });
  });

  it('(b) a selected reference set replaces the default links, so nothing unread is declared', () => {
    const selected = ctx({
      ...context,
      references: [{ entityId: 'doc-1', kind: 'doc', title: 'Doc one', via: 'selection' }],
    });
    const { manifest } = compose(selected, { on: true });
    expect(manifest.contextIndex!.groups.find((g) => g.name === 'references')!.omitted).toBe(0);
  });

  it('(a) the v1 snapshot drops only the titles the index names; <linked> keeps every id', () => {
    const { prompt } = compose(context, { on: true });
    expect(prompt.task).toContain('<entity id="doc-1" kind="doc" link="relates_to" />');
    expect(prompt.task).toContain('<entity id="doc-2" kind="doc" link="relates_to" />');
    expect(prompt.task).toContain('omitted="44"');
    expect(prompt.task).not.toContain('type="linked-names"');
  });

  it('(a) off: the snapshot is byte-identical to before (titles in linked-names)', () => {
    const { manifest, prompt } = compose(context);
    expect(manifest.contextIndex).toBeUndefined();
    expect(prompt.task).toContain(untrustedData({
      type: 'linked-names',
      body: JSON.stringify([{ entityId: 'doc-1', name: 'Doc one' }, { entityId: 'doc-2', name: 'Doc two' }]),
    }));
  });
});

describe('I5b: memory collapse (§10 Q1)', () => {
  const statement = (tag: string, n: number, extra = ''): string => `${tag} claim ${n} ${'m'.repeat(1500)}${extra}`;
  // 12 memories × ~1.5 KB ≈ 18 KB against the 12 KiB default.
  const withMemories = (texts: string[], via: ContextVia[], extra: Partial<SpawnContext> = {}) =>
    ctx({
      teamMember: { ...member, memories: texts, memoryIds: texts.map((_, i) => `mem-${i}`) },
      contextAudit: { selected: false, memoryVia: via, dropped: [] },
      ...extra,
    });

  it('collapses in the stated order with no rank: teammate > task > requested, unverified first, oldest first', () => {
    const texts = [
      statement('t', 0, ' [verified]'), statement('t', 1), statement('t', 2),
      statement('k', 3), statement('k', 4),
      statement('r', 5), statement('r', 6), statement('r', 7), statement('r', 8), statement('r', 9), statement('r', 10), statement('r', 11),
    ];
    const via = ['teammate', 'teammate', 'teammate', 'task', 'task', ...Array(7).fill('requested')] as ContextVia[];
    const collapse = collapseMemories({ texts, ids: texts.map((_, i) => `mem-${i}`), via, legacy: [], cap: BYTE_BUDGETS.memoryInjection });
    expect(collapse.rank).toBe('none');
    // Unverified teammate memories oldest first, then the verified one, then task ones.
    expect(collapse.collapsed.slice(0, 4)).toEqual([1, 2, 0, 3]);
    expect(collapse.used).toBeLessThanOrEqual(BYTE_BUDGETS.memoryInjection);
    expect(collapse.borrowed).toBe(0);
  });

  it('with a Jev rank: lowest score first, and a critical memory never collapses', () => {
    const texts = Array.from({ length: 12 }, (_, i) => statement('j', i));
    const ids = texts.map((_, i) => `mem-${i}`);
    const scores = ids.map((id, i) => ({ entityId: id, score: i === 0 ? 0.5 : 2.6, critical: i !== 0 }));
    const collapse = collapseMemories({ texts, ids, via: ids.map(() => 'selection' as const), legacy: [], scores, cap: BYTE_BUDGETS.memoryInjection });
    expect(collapse.rank).toBe('jev');
    expect(collapse.collapsed).toEqual([0]);
    // Eleven critical memories do not fit 12 KiB: they borrow, and it is recorded.
    expect(collapse.borrowed).toBe(collapse.used - BYTE_BUDGETS.memoryInjection);
    expect(collapse.borrowed).toBeGreaterThan(0);
  });

  it('records every collapse: body-level drop, collapsed index entry, rank:none + collapseOrder, the budget', () => {
    const texts = Array.from({ length: 12 }, (_, i) => statement('t', i, i === 3 ? ' [disputed]' : ''));
    const via = texts.map(() => 'teammate' as const);
    const { manifest, prompt } = compose(withMemories(texts, via), { on: true });
    const collapsed = manifest.context!.dropped!.filter((d) => d.group === 'memories' && d.level === 'body');
    expect(collapsed.length).toBeGreaterThan(0);
    const group = manifest.contextIndex!.groups.find((g) => g.name === 'memories')!;
    expect(group.entries.map((e) => e.id).sort()).toEqual(collapsed.map((d) => d.entityId).sort());
    expect(manifest.context!.groups!.memories).toMatchObject({ rank: 'none', collapseOrder: 'teammate>task>requested' });
    const budget = manifest.context!.budgets!.memoryInjection;
    expect(budget).toMatchObject({ cap: 12288, borrowed: 0 });
    expect(budget.used).toBeLessThanOrEqual(12288);
    // The prefix rule survives: agent.memory starts with exactly the kept memoryIds.
    expect(manifest.context!.memoryIds).toHaveLength(texts.length - collapsed.length);
    expect(manifest.agent.memory).toHaveLength(texts.length - collapsed.length);
    // Declared in the prompt, never clipped: the collapsed statement is an excerpt, tagged.
    expect(prompt.system).toContain('<group name="memories"');
    expect(prompt.system).toContain('excerpt="true"');
    const states = manifest.context!.entries!.filter((e) => e.group === 'memories').map((e) => e.state);
    expect(states.filter((s) => s === 'collapsed')).toHaveLength(collapsed.length);
    const disputed = group.entries.find((e) => e.id === 'mem-3');
    if (disputed) expect(disputed.tag).toBe('disputed');
  });

  it('refuses with BudgetExceededError naming memoryInjection when critical memories overflow the prompt', () => {
    const texts = Array.from({ length: 12 }, (_, i) => `c${i} ${'z'.repeat(3000)}`);
    const ids = texts.map((_, i) => `mem-${i}`);
    const context = withMemories(texts, ids.map(() => 'selection' as const), {
      memoryScores: ids.map((entityId) => ({ entityId, score: 3, critical: true })),
    });
    expect(() => compose(context, { on: true })).toThrow(expect.objectContaining({ name: 'BudgetExceededError', material: 'memoryInjection' }));
  });

  it('off: memories are never collapsed and nothing about them is recorded', () => {
    const texts = Array.from({ length: 6 }, (_, i) => statement('t', i));
    const { manifest } = compose(withMemories(texts, texts.map(() => 'teammate' as const)));
    expect(manifest.agent.memory).toHaveLength(6);
    expect(manifest.context!.budgets).toBeUndefined();
    expect(manifest.context!.dropped!.filter((d) => d.level === 'body')).toEqual([]);
  });

  it('a profile\'s contextBudgets replace the node defaults', () => {
    expect(contextBudgetsFrom({ draft: { contextBudgets: { memories: 4096, references: -1, skills: 2.5 } } })).toEqual({ memories: 4096 });
    expect(contextIndexCaps('worker', { references: 2048, teammates: 1024, skills: 4096 })).toEqual([
      { groups: ['memories'], cap: Number.MAX_SAFE_INTEGER },
      { groups: ['references'], cap: 2048 },
      { groups: ['teammates'], cap: 1024 },
      { groups: ['skills'], cap: 4096 },
    ]);
    expect(contextIndexCaps('dispatcher')[2]).toEqual({ groups: ['teammates'], cap: BYTE_BUDGETS.rosterIndex });
  });
});

describe('entries × dropped (index on): an id is shown with a header or body drop, never with any other', () => {
  it('holds for a collapsed memory, a header-dropped reference and an entry-dropped skill in one launch', () => {
    const texts = Array.from({ length: 12 }, (_, i) => `claim ${i} ${'m'.repeat(1500)}`);
    const linked = Array.from({ length: 40 }, (_, i) => ({ entityId: `doc-${i}`, kind: 'doc', link: 'relates_to', title: `Doc ${i}` }));
    const { manifest } = compose(ctx({
      teamMember: { ...member, memories: texts, memoryIds: texts.map((_, i) => `mem-${i}`) },
      contextAudit: { selected: false, memoryVia: texts.map(() => 'teammate' as const), dropped: [] },
      tasks: [task({ linked, linkedTotal: linked.length })],
      headers: linked.map((l) => docHeader(l.entityId)),
      skillEquips: Array.from({ length: 300 }, (_, i) => skillRow(i)),
    }), { on: true });
    const entries = manifest.context!.entries!;
    const dropped = manifest.context!.dropped!;
    const shown = new Set(entries.map((e) => `${e.group}:${e.entityId}`));
    const key = (d: { group: string; entityId: string }): string => `${d.group}:${d.entityId}`;

    // Each case is present in this launch.
    const collapsedMemory = dropped.find((d) => d.group === 'memories' && d.level === 'body');
    expect(collapsedMemory && shown.has(key(collapsedMemory))).toBe(true);
    const headerRef = dropped.find((d) => d.group === 'references' && d.level === 'header');
    expect(headerRef && shown.has(key(headerRef))).toBe(true);
    const entrySkill = dropped.find((d) => d.group === 'skills' && d.level === 'entry');
    expect(entrySkill && !shown.has(key(entrySkill))).toBe(true);

    // The invariant, over every drop.
    for (const drop of dropped) {
      if (shown.has(key(drop))) expect(['header', 'body']).toContain(drop.level);
    }
    // No id is dropped twice at the same level.
    const seen = new Set(dropped.map((d) => `${key(d)}:${d.reason}:${d.level ?? ''}`));
    expect(seen.size).toBe(dropped.length);
  });
});
