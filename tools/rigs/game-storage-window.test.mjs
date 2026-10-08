import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { runOwnedWindow } from './game-storage-window.mjs';

test('external deadline forces its own signal-resistant runner while an unrelated child stays alive', async () => {
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const receipt = await runOwnedWindow(process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { deadlineEpochMs: Date.now() + 400, reserveMs: 100, graceMs: 20, stdio: 'ignore' });
    assert.equal(receipt.deadlineReached, true);
    assert.ok(receipt.forcedStoppedPids.includes(receipt.runnerPid));
    assert.deepEqual(receipt.survivors, []);
    assert.ok(Date.parse(receipt.closedAt) <= Date.parse(receipt.windowEnd) + 150);
    assert.equal(unrelated.exitCode, null); assert.equal(unrelated.signalCode, null);
  } finally { const exited = once(unrelated, 'exit'); unrelated.kill(); await exited; }
});

test('missing agreed deadline is refused before any runner is launched', async () => {
  await assert.rejects(runOwnedWindow(process.execPath, [], { deadlineEpochMs: NaN }), /agreed future/);
});
