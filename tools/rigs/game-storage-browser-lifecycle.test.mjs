import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createBrowserLifecycle } from './game-storage-browser-lifecycle.mjs';

const child = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
async function stop(process, signal = 'SIGTERM') {
  if (process.exitCode !== null || process.signalCode !== null) return;
  const exited = once(process, 'exit'); process.kill(signal); await exited;
}
function fixture(process, events, options = {}) {
  const browser = Object.assign(new EventEmitter(), { isConnected: () => true, close: async () => {} });
  const server = { process: () => process, wsEndpoint: () => 'owned-test-endpoint',
    close: () => stop(process), kill: () => stop(process, 'SIGKILL') };
  const lifecycle = createBrowserLifecycle({ launchServer: async () => server, connect: async () => browser },
    { closeTimeoutMs: 20, checkpoint: event => events.push(event), ...options });
  return { browser, lifecycle };
}

test('stalled context teardown kills only the registered owned child and records the fallback', async () => {
  const owned = child(), unrelated = child(), events = [];
  const { lifecycle } = fixture(owned, events);
  try {
    const browser = await lifecycle.launch();
    await lifecycle.closeContext({ close: () => new Promise(() => {}) }, browser);
    assert.equal(owned.signalCode, 'SIGKILL');
    assert.equal(unrelated.signalCode, null);
    assert.equal(unrelated.exitCode, null);
    assert.deepEqual(lifecycle.diagnostics(), { browserCloseForced: 1 });
    assert.equal(events.find(event => event.boundary === 'forced').ownedBrowserPid, owned.pid);
    await lifecycle.closeBrowser(browser);
    assert.equal(lifecycle.diagnostics().browserCloseForced, 1);
  } finally { await stop(owned); await stop(unrelated); }
});

test('normal close completes without a forced kill and refuses unregistered browsers', async () => {
  const owned = child(), events = [];
  const { lifecycle } = fixture(owned, events);
  try {
    const browser = await lifecycle.launch();
    await lifecycle.closeContext({ close: async () => {} }, browser);
    await lifecycle.closeBrowser(browser);
    assert.equal(owned.signalCode, 'SIGTERM');
    assert.deepEqual(lifecycle.diagnostics(), { browserCloseForced: 0 });
    await assert.rejects(lifecycle.closeBrowser({}), /unregistered browser/);
  } finally { await stop(owned); }
});

test('evaluation checkpoints identify the pending operation and preserve its error', async () => {
  const events = [], failure = new Error('synthetic evaluation failure');
  const lifecycle = createBrowserLifecycle({}, { checkpoint: event => events.push(event) });
  await assert.rejects(lifecycle.evaluate({ evaluate: async () => { throw failure; } }, 'plain model geometry', () => {}),
    error => error === failure);
  assert.deepEqual(events.map(({ label, boundary }) => ({ label, boundary })),
    [{ label: 'evaluate: plain model geometry', boundary: 'before' }]);
});

test('crash, disconnection and owned process exit diagnostics retain their actual source', async () => {
  const owned = child(), events = [];
  const { lifecycle } = fixture(owned, events);
  try {
    const browser = await lifecycle.launch(), page = new EventEmitter();
    lifecycle.observePage(page, browser); lifecycle.observePage(page, browser);
    page.emit('crash'); browser.emit('disconnected');
    await lifecycle.closeBrowser(browser);
    const observed = events.filter(event => event.boundary === 'observed');
    assert.deepEqual(observed.map(event => event.label), ['page crash', 'browser disconnected', 'browser process exit']);
    assert.ok(observed.every(event => event.ownedBrowserPid === owned.pid));
    assert.equal(observed[2].exitCode, null);
    assert.equal(observed[2].exitSignal, 'SIGTERM');
  } finally { await stop(owned); }
});

test('raw owned stderr is captured before navigation without replacing the existing pipe reader', async () => {
  const owned = spawn(process.execPath, ['-e',
    "process.stdin.on('data', () => process.stderr.write('synthetic renderer fault\\n'))"],
  { stdio: ['pipe', 'ignore', 'pipe'] });
  const events = [], chunks = [], existingReader = [];
  owned.stderr.on('data', chunk => existingReader.push(chunk.toString()));
  const { lifecycle } = fixture(owned, events, { browserStderr: (pid, chunk) => chunks.push({ pid, text: chunk.toString() }) });
  try {
    const browser = await lifecycle.launch();
    const arrived = once(owned.stderr, 'data'); owned.stdin.write('emit'); await arrived;
    assert.deepEqual(chunks, [{ pid: owned.pid, text: 'synthetic renderer fault\n' }]);
    assert.deepEqual(existingReader, ['synthetic renderer fault\n']);
    assert.equal(events.find(event => event.label === 'browser ownership').executable, process.execPath);
    await lifecycle.closeBrowser(browser);
  } finally { await stop(owned); }
});
