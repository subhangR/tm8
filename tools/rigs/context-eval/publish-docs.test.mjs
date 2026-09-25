import { test } from 'node:test';
import assert from 'node:assert/strict';
import { laneTitle, laneBody, armTable, replaceArmTable, replaceSection } from './publish-docs.mjs';

const row = { arm: 'lean', taskKey: 'fee', model: 'sonnet5', rep: 1, sessionId: '01a0d953-dfdf-0000', family: 'needle', firstRequestTokens: 38266, usage: { input: 26, cacheCreation: 47383, cacheRead: 527579, output: 4093 }, requests: 13, toolCalls: 14, miss: { ids: {}, entry: { count: 0 }, header: { count: 1 } }, expand: { rate: 0.08, opened: 2, entries: 25 }, blindFetchBytes: 0, success: { committed: true, checks: { passed: 4, total: 4 }, closeout: true, ticked: true, success: true }, rubric: { score: 1, items: [{ name: 'checks', pass: true }] }, transcript: '/x.jsonl', node: { port: 4621, env: {} } };

test('title is stable, carries the run label, and a duplicate cell gets the session suffix', () => {
  assert.equal(laneTitle(row), 'lean · fee · sonnet5 · lane 1');
  assert.equal(laneTitle({ ...row, label: 'pilot' }), 'lean · fee · sonnet5 · lane 1 · pilot');
  assert.equal(laneTitle(row, true), 'lean · fee · sonnet5 · lane 1 · 01a0d953');
});

test('one table spans a pilot and a full run without collisions', () => {
  const t = armTable([{ ...row, label: 'pilot' }, { ...row, label: 'full', sessionId: 's2' }], new Map([[row.sessionId, 'D1'], ['s2', 'D2']]));
  assert.match(t, /\| 1 \| full \| fee \| sonnet5 \|.*\| D2 \|/);
  assert.match(t, /\| 1 \| pilot \| fee \| sonnet5 \|.*\| D1 \|/);
});

test('body carries the fields, the observation or a placeholder, and a start failure reason', () => {
  const b = laneBody(row, null);
  assert.match(b, /first-request tokens \| 38,266/);
  assert.match(b, /entry-level 0 · header-level 1/);
  assert.match(b, /start failure \| no/);
  assert.match(b, /none yet/);
  const b2 = laneBody({ ...row, excluded: { reason: 'start failure: auth-error' } }, 'looked fine');
  assert.match(b2, /yes — start failure: auth-error/);
  assert.match(b2, /\nlooked fine\n/);
});

test('the arm table is regenerated in place, keeping the prose around it', () => {
  const body = '# Arm lean\n\nStatus: RUNNING.\n\n| lane | task | model | doc |\n|---|---|---|---|\n(rows appended by the coordinator as lanes finish)\n\n## Notes\n\nkeep me\n';
  const out = replaceArmTable(body, armTable([row], new Map([[row.sessionId, 'DOC1']])));
  assert.match(out, /Status: RUNNING\./);
  assert.match(out, /\| 1 \| — \| fee \| sonnet5 \| 38,266 \| 574,988 \| 13 \| 0 \| 1 \| 8% \| 0 \| no \| yes \| DOC1 \|/);
  assert.doesNotMatch(out, /rows appended/);
  assert.match(out, /## Notes\n\nkeep me/);
  // idempotent: publishing again yields the same body
  assert.equal(replaceArmTable(out, armTable([row], new Map([[row.sessionId, 'DOC1']]))), out);
});

test('a section is replaced when present and appended when absent', () => {
  const a = replaceSection('# Root\n\nintro\n', 'Arm lean', 'summary A');
  assert.match(a, /## Arm lean\n\nsummary A/);
  const b = replaceSection(a + '\n## Arm inherit\n\nother\n', 'Arm lean', 'summary B');
  assert.match(b, /## Arm lean\n\nsummary B/);
  assert.doesNotMatch(b, /summary A/);
  assert.match(b, /## Arm inherit\n\nother/);
});
