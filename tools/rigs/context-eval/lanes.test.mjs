import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedConcurrency, loadTiers } from './lanes.mjs';

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
