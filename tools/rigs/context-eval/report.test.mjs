// node --test tools/rigs/context-eval/*.test.mjs
// The report over synthetic rows: a positive control (a known entry-level miss
// row is counted in the gate), a NEGATIVE control (mutating one row's miss
// level flips the gate row, so the report cannot be green by accident), the
// refusals, the rubric and the Clopper–Pearson bound.

import { test } from 'node:test';
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
import assert from 'node:assert/strict';
import { buildReport, classify, upperBound95, stats, annotateContamination, wroteAutoMemory, annotateCrossLane, annotateSiblingWorktree, annotateSiblingCommit } from './report.mjs';
import { guardMemoryDir, memoryDirFor } from './lanes.mjs';
import { planSlice, allowedConcurrency, rubricFor, foreignMainCommits } from './lanes.mjs';
import { syntheticStart } from './measure-row.mjs';
import { componentsOf } from './components.mjs';
import { skillsBlockBytes } from './measure-row.mjs';
import { laneCostUsd } from './pricing.mjs';

const FX = { schemaVersion: 2, contentHash: 'abc' };
function row(over = {}) {
  return {
    schema: 'context-eval.row.v1', slice: 'c1', arm: 'lean', node: { port: 4621 }, buildSha: 'deadbeef', fixtureVersion: FX,
    model: 'sonnet5', family: 'needle', taskKey: 'fee', rep: 1, sessionId: `s-${Math.random().toString(16).slice(2)}`, ended: 'idle', wallSeconds: 100, loadAtStart: 10, waitedSeconds: 0,
    firstRequestTokens: 30_000, requests: 6, toolCalls: 9, usage: { input: 1000, cacheCreation: 30_000, cacheRead: 150_000, output: 2000 }, costUsd: 0.2,
    system: { tm8Bytes: 13_000, harnessChars: 11_000, chromeChars: 4_000 }, firstUserBytes: 3000, attachments: { skill_listing: 20_000 },
    miss: { ids: {}, entry: { count: 0 }, header: { count: 0 } }, expand: { rate: 0.05 }, blindFetchBytes: 0,
    success: { success: true, deliverableCorrect: true, committed: true, closeout: true, ticked: true, checks: { passed: 4, total: 4, failures: [] } },
    subagentsMeasured: true, subagents: { files: 0, requests: 0, costUsd: 0 },
    rubric: { score: 1 }, needleOpened: true, components: { schema: 3, bytes: { tm8Kernel: 13_000, contextIndex: 0, contextIndexByGroup: {} }, tokens: {}, harnessTotal: 35_000 },
    ...over,
  };
}

test('positive control: a known entry-level miss row is counted in the gate', () => {
  const rows = [row(), row({ rep: 2, miss: { ids: { 'x': 'count-cap:entry' } } }), row({ arm: 'index-derived' }), row({ arm: 'index-derived', rep: 2 })];
  const r = buildReport(rows, null);
  assert.equal(r.json.gate['sonnet5/lean'].entryMissed, 1);
  assert.equal(r.json.gate['sonnet5/lean'].launches, 2);
  assert.equal(r.json.gate['sonnet5/index-derived'].entryMissed, 0);
  assert.match(r.md, /\| sonnet5 \| lean \| 2 \| 1 \| 50% \|/);
});

test('NEGATIVE control: changing one row from a header-level to an entry-level miss reds the gate row', () => {
  const base = [row(), row({ rep: 2, miss: { ids: { x: 'byte-budget:header' } } })];
  const green = buildReport(base, null).json.gate['sonnet5/lean'];
  assert.equal(green.entryMissed, 0, 'a header-level read is not gated');
  assert.equal(green.headerReads, 1);
  const mutated = base.map((r, i) => (i === 1 ? { ...r, miss: { ids: { x: 'byte-budget:entry' } } } : r));
  const red = buildReport(mutated, null).json.gate['sonnet5/lean'];
  assert.equal(red.entryMissed, 1, 'the mutated row must count');
  assert.notDeepEqual(red, green);
});

test('a header-level miss on a replica row never enters the gate, and replica accuracy is its own cell', () => {
  const rows = [row(), row({ family: 'replica', taskKey: 'replica-01a0d742', miss: { ids: { x: 'count-cap:entry' } }, success: { success: false, committed: false, closeout: true, ticked: true, checks: { passed: 0, total: 0, failures: [] } }, rubric: { score: 2 / 3 } })];
  const r = buildReport(rows, null);
  assert.equal(r.json.gate['sonnet5/lean'].launches, 1);
  assert.equal(r.json.accuracy['sonnet5/lean/replica'].n, 1);
  assert.equal(r.json.accuracy['sonnet5/lean/needle'].success, 1);
});

test('classify: excluded rows are set aside, an unmeasured non-excluded row is a defect', () => {
  const c = classify([row(), row({ firstRequestTokens: null, ended: 'no-transcript', excluded: { reason: 'start failure', by: 'auto' } }), row({ firstRequestTokens: null, measureError: 'no transcript' })]);
  assert.equal(c.measured.length, 1);
  assert.equal(c.excluded.length, 1);
  assert.equal(c.unmeasured.length, 1);
  const r = buildReport([row(), row({ firstRequestTokens: null, ended: 'no-transcript', excluded: { reason: 'start failure: trust prompt', by: 'auto' } })], null);
  assert.equal(r.json.failures['sonnet5/lean'].excluded, 1);
  assert.match(r.md, /start failure: trust prompt/);
});

test('baseline delta prints, and a different fixture version is refused', () => {
  const cur = [row({ firstRequestTokens: 31_000 }), row({ rep: 2, firstRequestTokens: 33_000 })];
  const prev = [row({ firstRequestTokens: 35_000 }), row({ rep: 2, firstRequestTokens: 37_000 })];
  const r = buildReport(cur, prev);
  assert.equal(r.json.delta['sonnet5/lean/needle']['first-request tokens'].delta, -4000);
  assert.match(r.md, /\| first-request tokens \| 36,000 \(n=2\) \| 32,000 \(n=2\) \| -4,000 \|/);
  assert.throws(() => buildReport(cur, prev.map((p) => ({ ...p, fixtureVersion: { schemaVersion: 3, contentHash: 'zzz' } }))), /not comparable/);
});

test('Clopper–Pearson: 0/14 → 19.3%, 0/59 < 5%, 1/93 < 5%', () => {
  assert.ok(Math.abs(upperBound95(0, 14) - 0.193) < 0.002, String(upperBound95(0, 14)));
  assert.ok(upperBound95(0, 59) < 0.05);
  assert.ok(upperBound95(0, 58) >= 0.05);
  assert.ok(upperBound95(1, 93) < 0.05);
  assert.equal(upperBound95(0, 0), null);
});

test('plan interleaves models first, load tiers gate concurrency', () => {
  const plan = planSlice({ keys: ['fee', 'stress30'], models: ['sonnet5', 'haiku45'], reps: 2 });
  assert.equal(plan.length, 8);
  assert.deepEqual(plan.slice(0, 4).map((c) => `${c.model}/${c.taskKey}`), ['sonnet5/fee', 'haiku45/fee', 'haiku45/stress30', 'sonnet5/stress30']);
  assert.equal(plan[0].rep, 1);
  assert.equal(plan[4].rep, 2);
  assert.equal(allowedConcurrency(10), 2);
  assert.equal(allowedConcurrency(40), 1);
  assert.equal(allowedConcurrency(80), 1);
  assert.equal(allowedConcurrency(80.1), 0);
});

test('rubric: memory needs the alias set, multiturn needs the turn set and a resume', () => {
  const success = { committed: true, closeout: true, ticked: true, checks: { total: 6, failures: [] } };
  const checks = [{ expr: 'fee(100)', set: 'base', pass: true }, { expr: 'fee2(100)', set: 'alias', pass: false }];
  const m = rubricFor('memory', { success, checkResults: checks });
  assert.equal(m.score, 4 / 5);
  assert.equal(m.items.find((i) => i.name === 'aliasCheck').pass, false);
  const t = rubricFor('multiturn', { success, turn: { resumed: true }, checkResults: [{ expr: 'a', set: 'base', pass: true }, { expr: 'b', set: 'turn', pass: true }] });
  assert.equal(t.score, 1);
  const t2 = rubricFor('multiturn', { success, turn: { resumed: false }, checkResults: [{ expr: 'a', set: 'base', pass: true }, { expr: 'b', set: 'turn', pass: true }] });
  assert.equal(t2.score, 5 / 6);
  assert.throws(() => rubricFor('nope', {}), /no rubric/);
});

test('components: kernel excludes the index, group bytes sum collapsed entries, remainder is the unmeasured share', () => {
  const measured = { system: { tm8Bytes: 20_000, harnessChars: 11_000, chromeChars: 4_000 }, firstUserBytes: 3000, attachments: { skill_listing: 20_000, agent_listing_delta: 2500 }, firstRequestTokens: 36_000 };
  const manifest = { context: { index: { bytes: 7000 }, budgets: { memoryInjection: { used: 1200 } }, entries: [{ group: 'references', state: 'collapsed', bytes: 5000 }, { group: 'skills', state: 'collapsed', bytes: 2000 }, { group: 'memories', state: 'expanded', bytes: 1200 }] } };
  const c = componentsOf({ measured, manifest });
  assert.equal(c.bytes.tm8Kernel, 20_000 - 7000 - 1200, 'kernel excludes the index AND the expanded memories');
  assert.equal(c.bytes.contextIndexByGroup.references, 5000);
  assert.equal(c.bytes.contextIndexByGroup.memories, 0);
  assert.equal(c.bytes.memoriesExpanded, 1200);
  assert.equal(c.harnessTotal, 11_000 + 20_000 + 2500);
  assert.ok(c.bytes.remainderEstimated > 0);
  const sum = c.tokens.tm8Kernel + c.tokens.memoriesExpanded + c.tokens.skillsListing + c.tokens.assignmentSnapshot + c.tokens.contextIndex + c.tokens.harness + c.tokens.remainderEstimated;
  assert.ok(Math.abs(sum - 36_000) <= 3, String(sum));
});

test('pricing: haiku is cheaper than sonnet for the same usage; an unknown model is null', () => {
  const usage = { input: 1000, cacheCreation: 30_000, cacheRead: 150_000, output: 2000 };
  assert.ok(laneCostUsd('claude-haiku-4-5-20251001', usage) < laneCostUsd('claude-sonnet-5', usage));
  assert.equal(laneCostUsd('claude-mystery', usage), null);
  assert.deepEqual(stats([3, 1, 2]), { n: 3, median: 2, min: 1, max: 3 });
});

test('start failures: a synthetic FIRST reply is set aside (auth or API error); a later synthetic reply is not', () => {
  const rec = (model, text) => JSON.stringify({ type: 'assistant', message: { model, content: [{ type: 'text', text }], usage: { input_tokens: 0 } } });
  const user = JSON.stringify({ type: 'user', message: { content: 'go' } });
  assert.equal(syntheticStart([user, rec('<synthetic>', 'Not logged in · Please run /login')].join('\n')).ended, 'auth-error');
  assert.equal(syntheticStart([user, rec('<synthetic>', 'API Error: 529 overloaded')].join('\n')).ended, 'synthetic-start');
  // A real first request, then a synthetic reply that happens to say "Not logged in": measured, not excluded.
  assert.equal(syntheticStart([user, rec('claude-sonnet-5', 'ok'), rec('<synthetic>', 'Not logged in')].join('\n')), null);
  assert.equal(syntheticStart(user), null);
});

test('classify: a 0-token first request is unmeasured, never a measured lane', () => {
  const c = classify([row(), row({ firstRequestTokens: 0 })]);
  assert.equal(c.measured.length, 1);
  assert.equal(c.unmeasured.length, 1);
});

test('rows spanning two fixture versions are refused (not only a baseline)', () => {
  assert.throws(() => buildReport([row(), row({ rep: 2, fixtureVersion: { schemaVersion: 2, contentHash: 'other' } })], null), /not comparable/);
});

test('fixture repo main: only the fixture commits are allowed', () => {
  assert.deepEqual(foreignMainCommits(['b75803c fixture skills', '8f4ed18 ledger-lite fixture', '']), []);
  assert.deepEqual(foreignMainCommits(['1a2b3c4 feat: taxFee helper', 'b75803c fixture skills', '8f4ed18 ledger-lite fixture']), ['1a2b3c4 feat: taxFee helper']);
});

test('report §5 flags a slice whose fixture main moved', () => {
  const r = buildReport([row({ base: 'aaaaaaaa11' }), row({ rep: 2, base: 'bbbbbbbb22' })], null);
  assert.deepEqual(r.json.load['c1 / 4621'].fixtureMainShas, ['aaaaaaaa11', 'bbbbbbbb22']);
  assert.match(r.md, /aaaaaaaa, bbbbbbbb ⚑ MOVED/);
});

test('components: memoriesExpanded comes from the entries on an index-OFF arm too (no memoryInjection budget) and leaves the kernel', () => {
  const measured = { system: { tm8Bytes: 30_000, harnessChars: 11_000, chromeChars: 0 }, firstUserBytes: 3000, attachments: {}, firstRequestTokens: 30_000 };
  const manifest = { context: { entries: [{ group: 'memories', state: 'expanded', bytes: 1169 }, { group: 'memories', state: 'expanded', bytes: 1152 }, { group: 'references', state: 'collapsed', bytes: 400 }] } };
  const c = componentsOf({ measured, manifest });
  assert.equal(c.bytes.memoriesExpanded, 2321);
  assert.equal(c.bytes.contextIndex, 0);
  assert.equal(c.bytes.tm8Kernel, 30_000 - 2321);
  assert.equal(c.schema, 3);
});

test('rows measured under components schema 1 are refused (kernel meaning changed): remeasure --all', () => {
  assert.throws(() => buildReport([row(), row({ rep: 2, components: { bytes: {} } })], null), /components schema 1.*remeasure/);
});

test('D7: the alias item is out of the rubric mean on EVERY arm, printed with k/n under its reading', () => {
  const items = (alias) => ['committed', 'checks', 'closeout', 'ticked'].map((name) => ({ name, pass: true })).concat([{ name: 'aliasCheck', pass: alias }]);
  const mem = (arm, alias) => row({ arm, family: 'memory', taskKey: 'mem-fee', rubric: { family: 'memory', items: items(alias), score: alias ? 1 : 0.8 } });
  const r = buildReport([mem('lean', false), mem('inherit', false), mem('index-derived', false)], null);
  for (const a of ['lean', 'inherit', 'index-derived']) assert.equal(r.json.accuracy[`sonnet5/${a}/memory`].rubricMean, 1, a);
  assert.match(r.md, /\| sonnet5 \| memory \| index-derived \| 1 \|[^\n]*alias memory trusted over conflicting skill 0\/1 \(not in the mean or success: D7\)/);
  assert.match(r.md, /\| sonnet5 \| memory \| lean \| 1 \|[^\n]*alias memory trusted over conflicting skill 0\/1/);
});

test('components: the index-off <skills> block leaves the kernel; on an index arm it is ignored (skills live in the index)', () => {
  const block = '  <skills>\n    <instruction>x</instruction>\n    <skill name="a"/>\n  </skills>';
  const snap = JSON.stringify({ type: 'attachment', attachment: { type: 'prompt_snapshot', systemPrompt: ['harness', `<tm8_system_prompt>\n  <identity/>\n${block}\n</tm8_system_prompt>`] } });
  assert.equal(skillsBlockBytes(snap), Buffer.byteLength(block));
  assert.equal(skillsBlockBytes(JSON.stringify({ type: 'attachment', attachment: { type: 'prompt_snapshot', systemPrompt: ['<tm8_system_prompt></tm8_system_prompt>'] } })), 0);
  const measured = { system: { tm8Bytes: 20_000, harnessChars: 0, chromeChars: 0, skillsBlockBytes: 4300 }, firstUserBytes: 0, attachments: {}, firstRequestTokens: 10_000 };
  const off = componentsOf({ measured, manifest: { context: { entries: [] } } });
  assert.equal(off.bytes.skillsListing, 4300);
  assert.equal(off.bytes.tm8Kernel, 20_000 - 4300);
  const on = componentsOf({ measured, manifest: { context: { index: { bytes: 5000 }, entries: [] } } });
  assert.equal(on.bytes.skillsListing, 0);
  assert.equal(on.bytes.tm8Kernel, 15_000);
});

test('D6: a withheld needle that was never opened is a SILENT context failure the gate cannot see; a recovery fetch is not', () => {
  const recovered = row({ needleState: 'absent', needleOpened: true, miss: { ids: { n: 'count-cap:entry' } } });
  const silent = row({ rep: 2, needleState: 'absent', needleOpened: false, success: { success: false } });
  const inlined = row({ rep: 3, needleState: 'expanded', needleOpened: false });
  const noNeedle = row({ rep: 4, family: 'memory', taskKey: 'mem-fee', needleState: null, needleOpened: null });
  const g = buildReport([recovered, silent, inlined, noNeedle], null).json.gate['sonnet5/lean'];
  assert.equal(g.entryMissed, 1, 'the recovery is the only D2 miss');
  assert.equal(g.silentContextFailures, 1, 'the never-opened absent needle is the silent failure');
  assert.equal(g.needleLaunches, 3, 'a row without a needle is not in the denominator');
  assert.equal(g.success, 3);
  // negative control: the same row opened is no longer silent
  const g2 = buildReport([recovered, { ...silent, needleOpened: true }, inlined, noNeedle], null).json.gate['sonnet5/lean'];
  assert.equal(g2.silentContextFailures, 0);
  assert.match(buildReport([recovered, silent, inlined, noNeedle], null).md, /\| sonnet5 \| lean \| 4 \| 1 \| 25% \|[^\n]*\| 1\/3 \(33%\) \| 0\/1 \| 3\/4 \(75%\) \|/);
});

test('D7: success and deliverable correct ignore the alias checks on EVERY arm; a failing base check still fails', () => {
  const checkResults = [{ expr: 'fee(100)', set: 'base', pass: true }, { expr: 'fee2(100)', set: 'alias', pass: false }];
  const success = { success: false, deliverableCorrect: false, committed: true, closeout: true, ticked: true, checks: { passed: 1, total: 2, failures: [{ expr: 'fee2(100)' }] } };
  const mem = (arm) => row({ arm, family: 'memory', taskKey: 'mem-fee', checkResults, success });
  const r = buildReport([mem('lean'), mem('inherit'), mem('index-derived'), mem('index-authored')], null).json;
  for (const a of ['lean', 'inherit', 'index-derived', 'index-authored']) {
    assert.equal(r.accuracy[`sonnet5/${a}/memory`].success, 1, a);
    assert.equal(r.accuracy[`sonnet5/${a}/memory`].deliverableCorrect, 1, a);
    assert.equal(r.gate[`sonnet5/${a}`].success, 1, a);
  }
  const baseFail = row({ family: 'memory', taskKey: 'mem-fee', success, checkResults: [{ expr: 'fee(100)', set: 'base', pass: false }, { expr: 'fee2(100)', set: 'alias', pass: true }] });
  assert.equal(buildReport([baseFail], null).json.accuracy['sonnet5/lean/memory'].success, 0);
  // a non-memory row keeps success.mjs's own verdict
  assert.equal(buildReport([row({ success: { success: false, deliverableCorrect: true } })], null).json.accuracy['sonnet5/lean/needle'].success, 0);
});

test('D8: per-key replica items; "asked the human" is counted, never scored 0; replica leaves success comparisons', () => {
  const items = (committed, closeout, ticked) => [{ name: 'committed', pass: committed }, { name: 'closeout', pass: closeout }, { name: 'ticked', pass: ticked }];
  const rep = (key, over) => row({ family: 'replica', taskKey: key, needleOpened: null, ...over });
  const docDone = rep('replica-01a0d742', { requests: 12, success: { committed: false, closeout: true, ticked: true }, rubric: { items: items(false, true, true), score: 2 / 3 } });
  const harness = rep('replica-01a0d778', { rep: 3, requests: 9, success: { committed: false, closeout: true, ticked: false }, rubric: { items: items(false, true, false), score: 1 / 3 } });
  const asked = rep('replica-01a0d742', { rep: 2, requests: 2, success: { committed: false, closeout: false, ticked: false }, rubric: { items: items(false, false, false), score: 0 } });
  const r = buildReport([docDone, harness, asked], null);
  const a = r.json.accuracy['sonnet5/lean/replica'];
  assert.equal(a.rubricMean, 1, 'committed n/a everywhere, ticked n/a on 01a0d778, the asked lane out of the mean');
  assert.equal(a.success, 2);
  assert.equal(a.scored, 2);
  assert.equal(a.askedTheHuman, 1);
  assert.match(r.md, /not a context measure in fixture v2[^|]*committed n\/a \(D8\) · closeout 2\/2 · ticked 1\/1 \(n\/a on 1: D8\) · asked the human 1\/3/);
  assert.match(r.md, /replica-01a0d778 \(code\): closeout;/);
  // negative control: 3 requests is not "asked the human", so the lane is scored and fails
  const b = buildReport([docDone, harness, { ...asked, requests: 3 }], null).json.accuracy['sonnet5/lean/replica'];
  assert.equal(b.askedTheHuman, 0);
  assert.equal(b.success, 2);
  assert.equal(b.scored, 3);
  assert.ok(b.rubricMean < 1);
  // an unmapped replica key is refused, never silently scored
  assert.throws(() => buildReport([rep('replica-new', { requests: 5, success: {}, rubric: { items: [] } })], null), /REPLICA_ITEMS/);
  // the delta never compares replica success or rubric
  const d = buildReport([docDone], [docDone]).json.delta['sonnet5/lean/replica'];
  assert.equal(d['success %'], undefined);
  assert.equal(d['mean rubric'], undefined);
  assert.ok(d['first-request tokens']);
});

test('D8 map matches its AUTHORITY: ticked applies exactly where fixtures/replicas-v2.json gives the replica criteria', async () => {
  const { REPLICA_ITEMS } = await import('./report.mjs');
  const { readFileSync } = await import('node:fs');
  const raw = JSON.parse(readFileSync(new URL('./fixtures/replicas-v2.json', import.meta.url), 'utf8'));
  const list = Array.isArray(raw) ? raw : (raw.replicas ?? Object.values(raw));
  assert.deepEqual(Object.keys(REPLICA_ITEMS).sort(), list.map((x) => x.key).sort());
  for (const x of list) {
    assert.equal(REPLICA_ITEMS[x.key].applies.includes('ticked'), (x.content?.acceptanceCriteria ?? []).length > 0, x.key);
    assert.ok(!REPLICA_ITEMS[x.key].applies.includes('committed'), x.key);
  }
});

test('subagents: the subagent transcripts of a lane fold into requests / usage / $; first request, components and misses stay with the main thread', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { measureRow } = await import('./measure-row.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'ctxeval-sub-'));
  const main = join(dir, 'native-1.jsonl');
  const asst = (id, model, u, tools = 0) => JSON.stringify({ type: 'assistant', message: { id, model, usage: u, content: Array.from({ length: tools }, (_, i) => ({ type: 'tool_use', id: `${id}-t${i}`, name: 'Read', input: {} })) } });
  writeFileSync(main, [
    JSON.stringify({ type: 'attachment', attachment: { type: 'prompt_snapshot', systemPrompt: ['harness', '<tm8_system_prompt>kernel</tm8_system_prompt>'] } }),
    JSON.stringify({ type: 'user', message: { content: 'do the task' } }),
    asst('m1', 'claude-sonnet-5', { input_tokens: 100, cache_creation_input_tokens: 20000, cache_read_input_tokens: 0, output_tokens: 50 }),
    asst('m2', 'claude-sonnet-5', { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 20000, output_tokens: 40 }),
  ].join('\n'));
  const args = { manifest: { sessionId: 's', launch: { model: 'claude-sonnet-5' }, context: { entries: [], dropped: [] } }, transcriptText: readText(main), transcriptPath: main, tpl: { linkedIds: [], needleId: null }, taskKey: 'fee' };
  function readText(f) { return require_('node:fs').readFileSync(f, 'utf8'); }
  const A = measureRow(args);
  assert.equal(A.subagentsMeasured, true);
  assert.equal(A.subagents.files, 0);
  assert.equal(A.requests, A.mainRequests);
  assert.deepEqual(A.usage, A.mainUsage);
  assert.equal(A.costUsd, A.mainCostUsd);
  // positive control: one subagent file (priced by ITS model) adds to the lane totals
  mkdirSync(join(dir, 'native-1', 'subagents'), { recursive: true });
  writeFileSync(join(dir, 'native-1', 'subagents', 'agent-x.jsonl'), [
    asst('s1', 'claude-haiku-4-5-20251001', { input_tokens: 5, cache_creation_input_tokens: 30000, cache_read_input_tokens: 0, output_tokens: 70 }, 2),
    asst('s1', 'claude-haiku-4-5-20251001', { input_tokens: 5, cache_creation_input_tokens: 30000, cache_read_input_tokens: 0, output_tokens: 70 }, 1),
    asst('s2', 'claude-haiku-4-5-20251001', { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 30000, output_tokens: 30 }),
  ].join('\n'));
  const B = measureRow(args);
  assert.equal(B.subagents.files, 1);
  assert.equal(B.subagents.requests, 2, 'one request per distinct message id');
  assert.equal(B.subagents.toolCalls, 3);
  assert.equal(B.requests, A.requests + 2);
  assert.equal(B.usage.cacheCreation, A.usage.cacheCreation + 30000);
  assert.ok(B.costUsd > A.costUsd && Math.abs(B.costUsd - A.costUsd - B.subagents.costUsd) < 1e-12);
  assert.deepEqual(B.mainUsage, A.usage);
  for (const k of ['firstRequestTokens', 'components', 'miss', 'expand', 'toolCalls', 'system', 'residentTm8Bytes', 'residentHarnessChars']) assert.deepEqual(B[k], A[k], k);
  // negative control: removing the file takes the lane back to exactly A
  rmSync(join(dir, 'native-1'), { recursive: true });
  assert.deepEqual(measureRow(args), A);
  assert.throws(() => measureRow({ ...args, transcriptPath: undefined }), /transcriptPath/);
  rmSync(dir, { recursive: true });
});

test('floor: a row measured without its subagent transcripts is refused (remeasure --all)', () => {
  assert.throws(() => buildReport([row(), row({ rep: 2, subagentsMeasured: undefined })], null), /without their subagent transcripts.*remeasure/);
});

test('D11: a lane that LOADED lane-written auto-memory is contaminated {by writer} and set aside; the writer is flagged', () => {
  const write = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/Users/x/.claude/projects/-private-tmp-ctxeval-node1-fixture-repo/memory/MEMORY.md', content: 'note' } }] } });
  const loaded = JSON.stringify({ type: 'user', message: { content: 'Contents of /Users/x/.claude/projects/-private-tmp-ctxeval-node1-fixture-repo/memory/MEMORY.md (user\'s auto-memory, persists across conversations):' } });
  const pathOnly = JSON.stringify({ type: 'attachment', attachment: { type: 'x', content: 'You have a persistent memory at /Users/x/.claude/projects/-private-tmp-ctxeval-node1-fixture-repo/memory/' } });
  const files = { w: write, a: loaded, b: pathOnly, c: loaded };
  const rows = [
    row({ sessionId: 'writer', transcript: 'w', startedAt: '2026-09-25T17:00:00Z' }),
    row({ sessionId: 'after', rep: 2, transcript: 'a', startedAt: '2026-09-25T17:05:00Z' }),
    row({ sessionId: 'clean', rep: 3, transcript: 'b', startedAt: '2026-09-25T17:06:00Z' }),
    row({ sessionId: 'other-node', rep: 4, transcript: 'c', startedAt: '2026-09-25T17:07:00Z', node: { port: 4624 } }),
  ];
  annotateContamination(rows, (f) => files[f] ?? null);
  assert.equal(rows[0].wroteAutoMemory, true);
  assert.deepEqual(rows[1].contaminated, { by: 'writer', via: 'auto-memory' });
  assert.equal(rows[2].contaminated, undefined, 'the bare memory path in the harness instructions is not a load');
  assert.deepEqual(rows[3].contaminated, { by: 'unknown', via: 'auto-memory' }, 'a writer on another node is not the source');
  const r = buildReport(rows, null);
  assert.equal(r.measured.length, 2, 'contaminated rows are set aside from every comparison');
  assert.equal(r.json.failures['sonnet5/lean'].excluded, 2);
  assert.equal(r.json.contamination.wroteAutoMemory.length, 1);
  assert.match(r.md, /2 row\(s\) LOADED lane-written memory/);
  // negative control: without the injection header nothing is contaminated
  const rows2 = rows.map((x) => ({ ...x, contaminated: undefined, wroteAutoMemory: undefined }));
  annotateContamination(rows2, (f) => (f === 'w' ? write : pathOnly));
  assert.equal(rows2.filter((x) => x.contaminated).length, 0);
  assert.equal(wroteAutoMemory(pathOnly), false);
  const bash = (command) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
  const M = '/Users/x/.claude/projects/-p-fixture-repo/memory';
  assert.equal(wroteAutoMemory(bash(`cat ${M}/notes.md 2>/dev/null; echo ---`)), false, 'a read with a stderr redirect is not a write');
  assert.equal(wroteAutoMemory(bash(`ls -la ${M}/ 2>&1`)), false);
  assert.equal(wroteAutoMemory(bash(`cat ${M}/x > /tmp/copy`)), false, 'reading memory into /tmp is not a write');
  assert.equal(wroteAutoMemory(bash(`echo note >> ${M}/MEMORY.md`)), true);
  assert.equal(wroteAutoMemory(bash(`cp /tmp/n.md ${M}/n.md`)), true);
  assert.equal(wroteAutoMemory(bash(`mkdir -p ${M}`)), true);
});

test('D11 guard: a non-empty memory dir is MOVED to <dataDir>/evidence before a spawn (never deleted); absent/empty pass', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'ctxeval-home-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'ctxeval-data-'));
  const repo = '/private/tmp/ctxeval/node9/fixture-repo';
  assert.equal(guardMemoryDir(repo, dataDir, { home }).memoryDirState, 'absent');
  const dir = memoryDirFor(repo, home);
  assert.ok(dir.endsWith('/.claude/projects/-private-tmp-ctxeval-node9-fixture-repo/memory'));
  mkdirSync(dir, { recursive: true });
  assert.equal(guardMemoryDir(repo, dataDir, { home }).memoryDirState, 'empty');
  writeFileSync(join(dir, 'MEMORY.md'), 'lane note');
  const g = guardMemoryDir(repo, dataDir, { home, now: new Date('2026-09-25T17:30:00Z') });
  assert.equal(g.memoryDirState, 'moved');
  assert.deepEqual(g.memoryDirMovedFiles, ['MEMORY.md']);
  assert.ok(!existsSync(dir), 'the live memory dir is gone');
  assert.deepEqual(readdirSync(g.memoryDirMovedTo), ['MEMORY.md'], 'the evidence is kept');
  rmSync(home, { recursive: true });
  rmSync(dataDir, { recursive: true });
});

test('D9 (h): "opened another copy of my task" counts a READ of a sibling task-copy id, never its own id or a mention in a message', () => {
  const A = '01a0d9a0-0000-7000-8000-00000000000a';
  const B = '01a0d9a0-0000-7000-8000-00000000000b';
  const bash = (command) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command } }] } });
  const files = {
    a: [bash(`tm8 entity context ${A} --format json`), bash(`tm8 entity context ${B} --format json`)].join('\n'),
    b: [bash(`tm8 entity context ${B}`), bash(`tm8 message send --to ${B} "saw ${A} in the doc connections"`)].join('\n'),
    c: bash(`tm8 message list --for ${A} --limit 20`),
  };
  const rows = [
    row({ sessionId: 'sa', taskId: A, transcript: 'a' }),
    row({ sessionId: 'sb', rep: 2, taskId: B, transcript: 'b' }),
    row({ sessionId: 'sc', rep: 3, taskId: '01a0d9a0-0000-7000-8000-00000000000c', transcript: 'c' }),
  ];
  annotateCrossLane(rows, (f) => files[f] ?? null);
  assert.deepEqual(rows[0].openedSiblingCopy, [{ taskId: B, sessionId: 'sb' }], 'reading a sibling copy counts; its own copy does not');
  assert.equal(rows[1].openedSiblingCopy, undefined, 'a mention inside a message body is not a read');
  assert.deepEqual(rows[2].openedSiblingCopy, [{ taskId: A, sessionId: 'sa' }], 'listing a sibling copy\'s messages (its closeout) counts');
  const r = buildReport(rows, null);
  assert.equal(r.json.crossLane.openedSiblingCopy.length, 2);
  assert.match(r.md, /2 row\(s\) OPENED another lane's copy of their task/);
  // negative control: no reads, no hops
  const quiet = rows.map((x) => ({ ...x, openedSiblingCopy: undefined }));
  annotateCrossLane(quiet, () => bash('ls'));
  assert.equal(quiet.filter((x) => x.openedSiblingCopy).length, 0);
});

test('D12: a row that READ another lane\'s worktree (absolute or relative path, main or subagent transcript) is set aside; its own worktree is not', () => {
  const W = '/private/tmp/ctxeval/node1/worktrees/01a0d95e-2639-789c-9c43-b9fe010cfaad';
  const tool = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
  const texts = {
    copier: [tool('Read', { file_path: `${W}/lane-own/src/ledger.js` }), tool('Bash', { command: 'cd /private/tmp/ctxeval/node1 && cat worktrees/01a0d95e-2639-789c-9c43-b9fe010cfaad/lane-sib/test/check-limit.test.js' })],
    sib: [tool('Read', { file_path: `${W}/lane-sib/src/ledger.js` })],
    viaSub: [tool('Read', { file_path: `${W}/lane-3/src/ledger.js` }), tool('Grep', { path: `${W}/lane-sib`, pattern: 'LIMIT' })],
  };
  const rows = [
    row({ sessionId: 'copier', worktree: `${W}/lane-own` }),
    row({ sessionId: 'sib', rep: 2, worktree: `${W}/lane-sib` }),
    row({ sessionId: 'viaSub', rep: 3, worktree: `${W}/lane-3` }),
  ];
  annotateSiblingWorktree(rows, (r) => texts[r.sessionId]);
  assert.deepEqual(rows[0].readSiblingWorktree, [{ path: 'worktrees/01a0d95e-2639-789c-9c43-b9fe010cfaad/lane-sib/test/check-limit.test.js', sessionId: 'sib' }], 'a relative path after cd <datadir> counts, and the path is recorded as named');
  assert.equal(rows[1].readSiblingWorktree, undefined, 'reading its own worktree is not a sibling read');
  assert.deepEqual(rows[2].readSiblingWorktree.map((o) => o.sessionId), ['sib'], 'a subagent/Grep path counts');
  const r = buildReport(rows, null);
  assert.equal(r.measured.length, 1, 'both copiers are set aside');
  assert.match(r.json.failures['sonnet5/lean'].reasons.join(' '), /copied from sibling worktree \(sib\)/);
  assert.match(r.md, /2 row\(s\) READ another lane's worktree/);
  // negative control: no sibling paths, nothing set aside
  const clean = rows.map((x) => ({ ...x, readSiblingWorktree: undefined }));
  annotateSiblingWorktree(clean, (x) => [texts.sib[0].replace('lane-sib', x.worktree.split('/').pop())]);
  assert.equal(clean.filter((x) => x.readSiblingWorktree).length, 0);
});

test('D12 §2: "silent + passed" counts a never-opened withheld needle whose checks all passed (the copy signature)', () => {
  const silentPass = row({ needleState: 'absent', needleOpened: false, success: { success: true, deliverableCorrect: true, committed: true, closeout: true, ticked: true } });
  const silentFail = row({ rep: 2, needleState: 'absent', needleOpened: false, success: { success: false, deliverableCorrect: false } });
  const opened = row({ rep: 3, needleState: 'absent', needleOpened: true });
  const g = buildReport([silentPass, silentFail, opened], null).json.gate['sonnet5/lean'];
  assert.equal(g.silentContextFailures, 2);
  assert.equal(g.silentPassed, 1);
  assert.match(buildReport([silentPass, silentFail, opened], null).md, /\| 2\/3 \(67%\) \| 1\/2 \|/);
});

test('D12 twin: a git read of a commit NOT in the lane\'s own branch history is a sibling-commit copy; its own commits and the base are not', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const dataDir = mkdtempSync(join(tmpdir(), 'ctxeval-git-'));
  const repo = join(dataDir, 'fixture-repo');
  const g = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'a.js'), 'base\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  const base = g('rev-parse', 'HEAD');
  const own = 'aaaaaaaa-0000-7000-8000-000000000001';
  const sib = 'aaaaaaaa-0000-7000-8000-000000000002';
  g('checkout', '-qb', `tm8/${sib}`);
  writeFileSync(join(repo, 'a.js'), 'the answer\n');
  g('commit', '-qam', 'sibling answer');
  const sibSha = g('rev-parse', 'HEAD');
  g('checkout', '-q', 'main');
  g('checkout', '-qb', `tm8/${own}`);
  writeFileSync(join(repo, 'a.js'), 'mine\n');
  g('commit', '-qam', 'own work');
  const ownSha = g('rev-parse', 'HEAD');
  const wt = (id) => join(dataDir, 'worktrees', 'proj', id);
  const bash = (command) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
  const texts = {
    copier: [bash('git log --oneline --all'), bash(`git show ${sibSha.slice(0, 7)}:a.js`), bash(`git show ${ownSha.slice(0, 7)} && git diff ${base.slice(0, 7)}`)],
    clean: [bash(`git show ${ownSha.slice(0, 7)} && git log --oneline -3`)],
  };
  const rows = [row({ sessionId: 'copier', worktree: wt(own) }), row({ sessionId: 'sib-lane', rep: 2, worktree: wt(sib) })];
  annotateSiblingCommit(rows, (r) => (r.sessionId === 'copier' ? texts.copier : []));
  assert.deepEqual(rows[0].readSiblingCommit, [{ sha: sibSha.slice(0, 12), sessionId: 'sib-lane' }], 'only the sibling commit; own commit and base are its own history');
  assert.equal(rows[0].listedAllRefs, true);
  assert.match(buildReport(rows, null).json.failures['sonnet5/lean'].reasons.join(' '), /copied from sibling commit/);
  // negative control: the lane reading only its own commits is clean
  const clean = [row({ sessionId: 'copier', worktree: wt(own) }), row({ sessionId: 'sib-lane', rep: 2, worktree: wt(sib) })];
  annotateSiblingCommit(clean, (r) => (r.sessionId === 'copier' ? texts.clean : []));
  assert.equal(clean[0].readSiblingCommit, undefined);
  assert.equal(clean[0].listedAllRefs, undefined);
  // no repo on this host: named shas are UNVERIFIED, never silently clean
  const far = [row({ sessionId: 'far', worktree: '/nowhere/worktrees/proj/x' })];
  annotateSiblingCommit(far, () => [bash(`git show ${sibSha.slice(0, 7)}`)]);
  assert.deepEqual(far[0].readSiblingCommitUnverified, [sibSha.slice(0, 7)]);
  rmSync(dataDir, { recursive: true });
});

test('report §5 prints the gate load; rows without it (pre-gateLoad runners) still report', () => {
  const r = buildReport([row({ gateLoad: 10.2, loadAtStart: 12.2 }), row({ rep: 2, loadAtStart: 11 })], null);
  assert.deepEqual(r.json.load['c1 / 4621'].gateLoad, { n: 1, median: 10.2, min: 10.2, max: 10.2 });
  assert.match(r.md, /\| c1 \/ 4621 \| 2 \| 10\.2 \[10\.2–10\.2\] n=1 \| /);
  const old = buildReport([row()], null);
  assert.equal(old.json.load['c1 / 4621'].gateLoad, null);
  assert.match(old.md, /\| c1 \/ 4621 \| 1 \| — \| /);
});
