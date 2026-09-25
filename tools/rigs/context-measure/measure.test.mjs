// node --test tools/rigs/context-measure/*.test.mjs
// The classifier on a synthetic lane: every read class, plus the refusals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureLane } from './measure.mjs';

const id = (n) => `01a0d700-0000-7000-8000-${String(n).padStart(12, '0')}`;
const TASK = id(1);
const DOC = id(2); // listed, collapsed
const NEEDLE = id(3); // listed, header trimmed by the cap
const GONE = id(4); // not selected
const ABSENT = id(5); // linked, in neither list
const BIG = id(6); // listed, collapsed, 30 KB
const MEM = id(7); // inlined at spawn
const SKILL = id(8);
const NATIVE = id(9);

const manifest = () => ({
  sessionId: 's',
  skills: [
    { entityId: SKILL, name: 'commit-style', sourcePath: '/repo/.claude/skills/commit-style/SKILL.md', loadPointer: '/repo/.claude/skills/commit-style/SKILL.md' },
    { entityId: NATIVE, name: 'csv-hygiene', sourcePath: '/repo/.claude/skills/csv-hygiene/SKILL.md', loadPointer: '/csv-hygiene' },
  ],
  context: {
    entries: [
      { entityId: DOC, group: 'references', state: 'collapsed', bytes: 900 },
      { entityId: NEEDLE, group: 'references', state: 'header-dropped', bytes: 1500 },
      { entityId: BIG, group: 'references', state: 'collapsed', bytes: 30_000 },
      { entityId: MEM, group: 'memories', state: 'expanded', bytes: 300 },
      { entityId: SKILL, group: 'skills', state: 'collapsed', bytes: 200 },
      { entityId: NATIVE, group: 'skills', state: 'collapsed', bytes: 200 },
    ],
    dropped: [
      { entityId: NEEDLE, reason: 'byte-budget', level: 'header' },
      { entityId: GONE, reason: 'not-selected' },
    ],
  },
});

function transcript(calls) {
  const lines = [
    { type: 'attachment', attachment: { type: 'prompt_snapshot', systemPrompt: ['harness', '<tm8_system_prompt>x</tm8_system_prompt>'] } },
    { type: 'user', message: { content: 'do the task' } },
  ];
  calls.forEach(([name, input, result = 'ok'], i) => {
    const tid = `toolu_${i}`;
    lines.push({ type: 'assistant', message: { id: `msg_${i}`, usage: { input_tokens: 10, output_tokens: 1 }, content: [{ type: 'tool_use', id: tid, name, input }] } });
    lines.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: tid, content: result }] } });
  });
  return lines.map((l) => JSON.stringify(l));
}

test('each read lands in its class, and misses carry their level', () => {
  const row = measureLane({
    manifest: manifest(),
    linked: [DOC, NEEDLE, GONE, ABSENT],
    transcriptLines: transcript([
      ['Bash', { command: `tm8 entity context ${TASK} --format json` }],
      ['Bash', { command: `tm8 entity get --full ${DOC} --format json` }],
      ['Bash', { command: `tm8 entity context ${NEEDLE}` }],
      ['Bash', { command: `tm8 entity get ${GONE}` }],
      ['Bash', { command: `tm8 entity context ${ABSENT}` }],
      ['Skill', { skill: 'csv-hygiene' }],
      ['Read', { file_path: '/repo/.claude/skills/commit-style/SKILL.md' }],
    ]),
  });
  const cls = Object.fromEntries(row.reads.map((r) => [r.id, r.class]));
  assert.deepEqual(cls, { [TASK]: 'other', [DOC]: 'expand', [NEEDLE]: 'miss', [GONE]: 'miss', [ABSENT]: 'miss', [NATIVE]: 'expand', [SKILL]: 'expand' });
  assert.deepEqual(row.miss.ids, { [NEEDLE]: 'byte-budget:header', [GONE]: 'not-selected:-', [ABSENT]: 'absent-from-index' });
  // DOC, NEEDLE (listed, so also opened), NATIVE, SKILL; §7.2 divides by all entries.
  assert.equal(row.expand.opened, 4);
  assert.equal(row.expand.rate, 4 / 6);
  assert.equal(row.expand.rateOfCollapsed, 4 / 5);
});

test('a shell cat of a worktree-relative SKILL.md is a skill read', () => {
  const row = measureLane({ manifest: manifest(), transcriptLines: transcript([['Bash', { command: 'cat .claude/skills/commit-style/SKILL.md' }]]) });
  assert.deepEqual(row.reads.map((r) => [r.id, r.class]), [[SKILL, 'expand']]);
});

test('blind fetch: unpaged big reads count once per tool call; --offset is paging', () => {
  const big = 'x'.repeat(25_000);
  const row = measureLane({
    manifest: manifest(),
    transcriptLines: transcript([
      ['Bash', { command: `tm8 entity context ${BIG}; tm8 entity get ${BIG}` }, big],
      ['Bash', { command: `tm8 entity context ${BIG} --offset 2` }, big],
    ]),
  });
  assert.equal(row.reads.length, 3);
  assert.equal(row.blindFetchBytes, 25_000);
});

test('refuses to measure nothing', () => {
  const good = transcript([]);
  assert.throws(() => measureLane({ manifest: { sessionId: 's' }, transcriptLines: good }), /no context audit/);
  assert.throws(() => measureLane({ manifest: manifest(), transcriptLines: [] }), /no records/);
  assert.throws(() => measureLane({ manifest: manifest(), transcriptLines: good.slice(0, 2) }), /no API response/);
  assert.throws(() => measureLane({ manifest: manifest(), transcriptLines: good.slice(1) }), /no prompt_snapshot/);
});

test('refuses a manifest whose entries and dropped disagree', () => {
  const m = manifest();
  m.context.dropped.push({ entityId: DOC, reason: 'count-cap', level: 'entry' });
  assert.throws(() => measureLane({ manifest: m, transcriptLines: transcript([]) }), /dropped .* vs entry state collapsed/);
  const n = manifest();
  n.context.dropped = n.context.dropped.filter((d) => d.entityId !== NEEDLE);
  assert.throws(() => measureLane({ manifest: n, transcriptLines: transcript([]) }), /header-dropped with no header-level drop/);
});

test('a summary-dropped entry kept its whenToUse, so opening it is an expand; the lists must still agree', () => {
  const m = manifest();
  m.context.entries[1] = { entityId: NEEDLE, group: 'references', state: 'summary-dropped', bytes: 400 };
  m.context.dropped[0] = { entityId: NEEDLE, reason: 'byte-budget', level: 'summary' };
  const row = measureLane({
    manifest: m,
    linked: [DOC, NEEDLE],
    transcriptLines: transcript([['Bash', { command: `tm8 entity context ${NEEDLE}` }]]),
  });
  assert.equal(row.reads.find((r) => r.id === NEEDLE).class, 'expand');
  assert.deepEqual(row.miss.ids, {});
  const n = manifest();
  n.context.entries[1] = { entityId: NEEDLE, group: 'references', state: 'summary-dropped', bytes: 400 };
  assert.throws(() => measureLane({ manifest: n, transcriptLines: transcript([]) }), /dropped .* vs entry state summary-dropped/);
  n.context.dropped = n.context.dropped.filter((d) => d.entityId !== NEEDLE);
  assert.throws(() => measureLane({ manifest: n, transcriptLines: transcript([]) }), /summary-dropped with no summary-level drop/);
});

test('D2: header- and body-level drops are header reads; every other miss is entry-level', async () => {
  const { missLevel } = await import('./measure.mjs');
  for (const why of ['byte-budget:header', 'byte-budget:body']) assert.equal(missLevel(why), 'header', why);
  for (const why of ['byte-budget:entry', 'count-cap:entry', 'not-selected:-', 'absent-from-index']) assert.equal(missLevel(why), 'entry', why);
});

test('Q1: a memory dropped at BODY level is a listed, collapsed entry; opening it is a header-level read, not an entry miss', () => {
  const MEMC = id(10);
  const m = manifest();
  m.context.entries.push({ entityId: MEMC, group: 'memories', state: 'collapsed', bytes: 1400 });
  m.context.dropped.push({ entityId: MEMC, reason: 'byte-budget', level: 'body' });
  const row = measureLane({ manifest: m, linked: [], transcriptLines: transcript([['Bash', { command: `tm8 entity context ${MEMC} --format json` }]]) });
  assert.equal(row.miss.header.count, 1);
  assert.equal(row.miss.entry.count, 0);
  assert.equal(row.miss.ids[MEMC], 'byte-budget:body');
  // and the two wrong shapes still throw
  const bad = manifest();
  bad.context.entries.push({ entityId: MEMC, group: 'memories', state: 'expanded', bytes: 1400 });
  bad.context.dropped.push({ entityId: MEMC, reason: 'byte-budget', level: 'body' });
  assert.throws(() => measureLane({ manifest: bad, linked: [], transcriptLines: transcript([]) }), /vs entry state expanded/);
});


test('Q1: a collapsed memory whose index line was ALSO trimmed (body + entry drops, no entry) measures as an ENTRY-level miss', () => {
  const MEMT = id(11);
  const m = manifest();
  m.context.dropped.push({ entityId: MEMT, reason: 'byte-budget', level: 'body' }, { entityId: MEMT, reason: 'byte-budget', level: 'entry' });
  const row = measureLane({ manifest: m, linked: [], transcriptLines: transcript([['Bash', { command: `tm8 entity context ${MEMT} --format json` }]]) });
  assert.equal(row.miss.ids[MEMT], 'byte-budget:entry');
  assert.equal(row.miss.entry.count, 1);
  assert.equal(row.miss.header.count, 0);
  // negative control: a body drop with no entry and NO entry-level drop is still refused
  const bad = manifest();
  bad.context.dropped.push({ entityId: MEMT, reason: 'byte-budget', level: 'body' });
  assert.throws(() => measureLane({ manifest: bad, linked: [], transcriptLines: transcript([]) }), /byte-budget:body\) vs entry state absent/);
});
