import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedConcurrency, isLoadWait, loadTiers, newRow, startLine } from './lanes.mjs';

test('default tiers: 2 under 40, 1 at 40..80, 0 above 80', () => {
  assert.equal(allowedConcurrency(39.9, 2), 2);
  assert.equal(allowedConcurrency(40, 2), 1);
  assert.equal(allowedConcurrency(80, 2), 1);
  assert.equal(allowedConcurrency(80.1, 2), 0);
  assert.deepEqual(loadTiers(undefined), { two: 40, one: 80 });
});

test('--load-max lowers the ceiling for a shared box', () => {
  const tiers = loadTiers('12');
  assert.deepEqual(tiers, { two: 12, one: 12 });
  assert.equal(allowedConcurrency(11.9, 1, tiers), 1);
  assert.equal(allowedConcurrency(12.01, 1, tiers), 0);
  assert.equal(allowedConcurrency(11.9, 2, tiers), 2);
  assert.throws(() => loadTiers('x'), /not a positive number/);
});

test('an unreadable load refuses instead of running unthrottled', () => {
  // Linux `uptime` prints `12.65, 10.46, ...`: Number('12.65,') is NaN, which
  // compared false against every tier and let lanes start at any load.
  assert.throws(() => allowedConcurrency(Number('12.65,'), 2), /unreadable load/);
});

test('gateLoad: the row and the start line carry the load the gate compared, not only the later uptime read', () => {
  const node = { arm: 'lean', port: 4621, db: 'tm8_eval1', env: {}, buildSha: 'x', teammates: { 'Sonnet 5 Eval': 'tm-1' } };
  const nodeFx = { tasks: { fee: { family: 'needle', templateId: 't-1' } } };
  const gated = newRow({ node, nodeFx, cell: { model: 'sonnet5', taskKey: 'fee', rep: 1, gateLoad: 10.23 }, slice: 'c1', fixtureVersion: {}, base: 'b' });
  assert.equal(gated.gateLoad, 10.23);
  // An older cell (no gate sample) records null, never a guess.
  assert.equal(newRow({ node, nodeFx, cell: { model: 'sonnet5', taskKey: 'fee', rep: 1 }, slice: 'c1', fixtureVersion: {}, base: 'b' }).gateLoad, null);
  const line = startLine('c1/sonnet5/fee#1', { ...gated, sessionId: 's-1', uptimeStart: '12.23, 15.93, 20.16' });
  assert.equal(line, 'c1/sonnet5/fee#1 session s-1 gate 10.23 load 12.23, 15.93, 20.16');
  assert.match(startLine('t', { sessionId: 's', uptimeStart: 'u' }), / gate - load u$/);
});

test('waitedSeconds counts only a LOAD block with a free slot, never a busy slot', () => {
  // --concurrency 1: a lane in flight holds the only slot; load over the cap is not a wait.
  assert.equal(isLoadWait(1, 0, 1), false);
  // --concurrency 1, slot free, load over the cap: a load wait.
  assert.equal(isLoadWait(0, 0, 1), true);
  // Slot free and the load allows a start: the runner starts, no wait.
  assert.equal(isLoadWait(0, 1, 1), false);
  // --concurrency 2 at the 40..80 tier: one running, the second slot is blocked by load.
  assert.equal(isLoadWait(1, 1, 2), true);
  // --concurrency 2, both slots busy: the plan, not load.
  assert.equal(isLoadWait(2, 1, 2), false);
  assert.equal(isLoadWait(2, 0, 2), false);
});
