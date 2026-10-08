import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

test('deadline includes a child spawned by a Worker thread and preserves an unrelated control', async () => {
  const dir = await mkdtemp('/tmp/tm8-storage-thread-ownership-'), pointer = `${dir}/child.json`;
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const worker = `const fs = require('node:fs');
    const child = require('node:child_process').spawn(process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {stdio: 'ignore'});
    const raw = fs.readFileSync('/proc/' + child.pid + '/stat', 'utf8');
    fs.writeFileSync(${JSON.stringify(pointer)}, JSON.stringify({pid: child.pid,
      startTicks: raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19]}));
    setInterval(() => {}, 1000);`;
  const root = `process.on('SIGTERM', () => {});
    new (require('node:worker_threads').Worker)(${JSON.stringify(worker)}, {eval: true});
    setInterval(() => {}, 1000);`;
  let ownedChild;
  try {
    const receipt = await runOwnedWindow(process.execPath, ['-e', root],
      { deadlineEpochMs: Date.now() + 2_000, reserveMs: 500, graceMs: 20, stdio: 'ignore' });
    ownedChild = JSON.parse(await readFile(pointer, 'utf8'));
    assert.ok(receipt.capturedOwnedPids.includes(receipt.runnerPid));
    assert.ok(receipt.capturedOwnedPids.includes(ownedChild.pid), 'Worker-thread child is included');
    assert.ok(receipt.forcedStoppedPids.includes(receipt.runnerPid));
    assert.ok(receipt.forcedStoppedPids.includes(ownedChild.pid));
    assert.deepEqual(receipt.survivors, []);
    assert.equal(unrelated.exitCode, null); assert.equal(unrelated.signalCode, null);
  } finally {
    // Clean the fixture even if the ownership assertion catches a regression.
    ownedChild ??= await readFile(pointer, 'utf8').then(JSON.parse).catch(() => null);
    if (ownedChild) {
      const raw = await readFile(`/proc/${ownedChild.pid}/stat`, 'utf8').catch(() => null);
      if (raw && raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19] === ownedChild.startTicks) {
        try { process.kill(ownedChild.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
    const exited = once(unrelated, 'exit'); unrelated.kill(); await exited;
    await rm(dir, {recursive: true, force: true});
  }
});
