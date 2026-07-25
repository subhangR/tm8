// @tm8/execution PTY host harness — proof WITHOUT the full server.
//
// Spawns REAL PTYs (bash) through the lifted PtyHostService and asserts the
// four load-bearing behaviors end to end:
//   1. spawn a real PTY and capture its output
//   2. live output is COALESCED into 16ms frames (far fewer frames than writes)
//   3. a mid-stream attach REPLAYS byte-exactly from the client's offset
//      (no gap, no duplication) and continues live
//   4. process EXIT propagates: onSessionStatus fires + an {type:'exit'} frame
//      reaches every subscriber; and an explicit kill() propagates likewise
//
// MUST run under node, never bun (node-pty onData never fires under bun, and
// bun strips the spawn-helper exec bit). Run:  node harness/pty-harness.mjs
// (or: npm run harness)  from packages/execution.

import assert from 'node:assert';
import { PtyHostService } from '../dist/index.js';

const CWD = process.cwd();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, { timeoutMs = 8000, stepMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(stepMs);
  }
  throw new Error('waitFor: timed out');
}

const quietLogger = { error() {}, warn() {}, info() {}, debug() {} };

/**
 * A recording FrameSink. Separates raw PTY output bytes from JSON control
 * frames (currently only {type:'exit'}), so byte-offset math ignores control
 * traffic exactly like a real client would.
 */
function makeSink() {
  const outChunks = [];
  const control = [];
  const sink = {
    readyState: 1,
    send(d) {
      const b = Buffer.isBuffer(d) ? d : Buffer.from(String(d), 'utf8');
      const s = b.toString('utf8');
      if (s.startsWith('{') && s.endsWith('}')) {
        try {
          const j = JSON.parse(s);
          if (j && typeof j === 'object' && 'type' in j) {
            control.push(j);
            return;
          }
        } catch {
          /* not a control frame — fall through as output */
        }
      }
      outChunks.push(b);
    },
    close() {},
  };
  return {
    sink,
    output: () => Buffer.concat(outChunks),
    frameCount: () => outChunks.length,
    control: () => control,
    exited: () => control.some((c) => c.type === 'exit'),
  };
}

const results = [];
function check(name, fn) {
  return (async () => {
    try {
      await fn();
      results.push([true, name]);
      console.log(`  ✓ ${name}`);
    } catch (err) {
      results.push([false, name]);
      console.log(`  ✗ ${name}\n      ${err && err.message}`);
    }
  })();
}

async function main() {
  const statuses = [];
  const host = new PtyHostService({
    logger: quietLogger,
    onSessionStatus: (id, status) => {
      statuses.push({ id, status });
    },
  });

  console.log('tm8 @tm8/execution — PTY host harness\n');

  // ---- 1 + 2: spawn a real PTY; live output coalesces into frames ----------
  await check('spawn a real PTY and coalesce a 200-line burst into few frames', async () => {
    const s = makeSink();
    const LINES = 200;
    host.spawn({
      sessionId: 'burst',
      command: `for i in $(seq 1 ${LINES}); do echo "L$i"; done`,
      cwd: CWD,
      env: {},
    });
    assert.ok(host.hasSession('burst'), 'session should be live right after spawn');
    const meta = await host.attach('burst', s.sink, 0);
    assert.ok(meta, 'attach returned handshake metadata');
    assert.equal(meta.gap, 0, 'fresh attach has no gap');
    assert.ok(typeof meta.epoch === 'string' && meta.epoch.length > 0, 'epoch present');

    await waitFor(() => s.exited());
    const text = s.output().toString('utf8');
    const got = text.split(/\r?\n/).filter((l) => /^L\d+$/.test(l));
    assert.equal(got.length, LINES, `captured all ${LINES} lines (got ${got.length})`);
    assert.equal(got[0], 'L1');
    assert.equal(got[LINES - 1], `L${LINES}`);
    // Coalescing: without 16ms framing this is ~1 frame per echoed line.
    assert.ok(
      s.frameCount() < LINES,
      `coalesced ${LINES} line-writes into ${s.frameCount()} frames (must be < ${LINES})`,
    );
    console.log(`      (coalesced into ${s.frameCount()} frame(s) for ${LINES} line-writes)`);
  });

  // ---- 3: mid-stream attach replays byte-exactly from an offset ------------
  await check('mid-stream attach replays byte-exactly from client offset', async () => {
    const a = makeSink();
    host.spawn({
      sessionId: 'paced',
      command: 'for i in $(seq 1 10); do echo "P$i"; sleep 0.06; done',
      cwd: CWD,
      env: {},
    });
    await host.attach('paced', a.sink, 0);

    // Wait until subscriber A has actually received a few lines (deterministic,
    // not a fixed sleep that races bash startup), then attach B mid-stream from
    // A's exact byte offset — several more lines are still flowing live.
    const linesSeen = () => (a.output().toString('utf8').match(/P\d+/g) || []).length;
    await waitFor(() => linesSeen() >= 3);
    const X = a.output().length;
    assert.ok(X > 0, 'subscriber A received output before mid-stream attach');

    const b = makeSink();
    const meta = await host.attach('paced', b.sink, X);
    assert.ok(meta, 'mid-stream attach returned metadata');
    assert.equal(meta.gap, 0, 'retained offset ⇒ no gap');
    assert.equal(meta.base, X, 'replay base equals requested offset');

    await waitFor(() => a.exited() && b.exited());
    const fullA = a.output();
    const fullB = b.output();
    assert.ok(fullB.length > 0, 'B received the suffix');
    assert.ok(fullB.length < fullA.length, 'B saw strictly less than A (a suffix)');
    assert.equal(
      Buffer.compare(fullA.subarray(X), fullB),
      0,
      'B == A[X:] byte-for-byte (no gap, no duplication)',
    );
    console.log(
      `      (A=${fullA.length}B, attached B at offset ${X}, B=${fullB.length}B, suffix matched)`,
    );
  });

  // ---- 4a: natural exit propagates status + exit frame ---------------------
  await check('natural exit propagates onSessionStatus + exit frame to subscribers', async () => {
    const s = makeSink();
    host.spawn({ sessionId: 'exit0', command: 'echo done; exit 0', cwd: CWD, env: {} });
    await host.attach('exit0', s.sink, 0);
    await waitFor(() => s.exited());
    const st = statuses.find((x) => x.id === 'exit0');
    assert.ok(st, 'onSessionStatus fired for exit0');
    assert.equal(st.status, 'completed', 'exit code 0 ⇒ completed');
    const exitFrame = s.control().find((c) => c.type === 'exit');
    assert.ok(exitFrame, 'subscriber received an {type:"exit"} frame');
    assert.equal(exitFrame.exitCode, 0, 'exit frame carries exit code 0');
    assert.ok(!host.hasSession('exit0'), 'session removed after exit');
  });

  // ---- 4b: non-zero exit maps to failed -----------------------------------
  await check('non-zero exit maps to failed', async () => {
    const s = makeSink();
    host.spawn({ sessionId: 'exit3', command: 'exit 3', cwd: CWD, env: {} });
    await host.attach('exit3', s.sink, 0);
    await waitFor(() => s.exited());
    const st = statuses.find((x) => x.id === 'exit3');
    assert.ok(st, 'onSessionStatus fired for exit3');
    assert.equal(st.status, 'failed', 'non-zero exit ⇒ failed');
  });

  // ---- 4c: explicit kill propagates an exit frame; outcome is 'killed' -----
  await check('explicit kill() propagates exit frame and returns killed', async () => {
    const s = makeSink();
    host.spawn({ sessionId: 'longrun', command: 'sleep 30', cwd: CWD, env: {} });
    await host.attach('longrun', s.sink, 0);
    host.write('longrun', ''); // write path must not throw
    host.resize('longrun', 100, 40); // resize path must not throw
    const outcome = host.kill('longrun', true);
    assert.equal(outcome, 'killed', 'kill of a live session returns "killed"');
    await waitFor(() => s.exited());
    assert.ok(!host.hasSession('longrun'), 'session removed after kill');
    assert.equal(host.kill('nope-not-here', true), 'not_found', 'kill of unknown ⇒ not_found');
  });

  host.shutdownAll();

  const failed = results.filter(([ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('FAILED:', failed.map(([, n]) => n).join('; '));
    process.exit(1);
  }
  console.log('HARNESS GREEN');
  process.exit(0);
}

main().catch((err) => {
  console.error('harness crashed:', err);
  process.exit(1);
});
