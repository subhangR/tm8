// node --test tools/rigs/context-eval/*.test.mjs
// The report over synthetic rows: a positive control (a known entry-level miss
// row is counted in the gate), a NEGATIVE control (mutating one row's miss
// level flips the gate row, so the report cannot be green by accident), the
// refusals, the rubric and the Clopper–Pearson bound.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, classify, upperBound95, stats } from './report.mjs';
import { planSlice, allowedConcurrency, rubricFor, foreignMainCommits } from './lanes.mjs';
import { syntheticStart } from './measure-row.mjs';
import { componentsOf } from './components.mjs';
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
    rubric: { score: 1 }, needleOpened: true, components: { bytes: { tm8Kernel: 13_000, contextIndex: 0, contextIndexByGroup: {} }, tokens: {}, harnessTotal: 35_000 },
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
  const rows = [row(), row({ family: 'replica', taskKey: 'replica-x', miss: { ids: { x: 'count-cap:entry' } }, success: { success: false, committed: false, closeout: true, ticked: true, checks: { passed: 0, total: 0, failures: [] } }, rubric: { score: 2 / 3 } })];
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
  assert.equal(c.bytes.tm8Kernel, 13_000);
  assert.equal(c.bytes.contextIndexByGroup.references, 5000);
  assert.equal(c.bytes.contextIndexByGroup.memories, 0);
  assert.equal(c.bytes.memoriesExpanded, 1200);
  assert.equal(c.harnessTotal, 11_000 + 20_000 + 2500);
  assert.ok(c.bytes.remainderEstimated > 0);
  const sum = c.tokens.tm8Kernel + c.tokens.assignmentSnapshot + c.tokens.contextIndex + c.tokens.harness + c.tokens.remainderEstimated;
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
