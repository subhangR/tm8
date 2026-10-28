// @tm8/execution PTY daemon throughput bench — `seq 1 100000` through a REAL
// PtyHostService with ONE live subscriber, the shape of a busy agent burst.
//
// Reports, per run and as the median over runs:
//   exitMs     spawn → the {type:'exit'} frame reached the subscriber (every
//              output frame is flushed before it, so this is "last frame")
//   settledMs  spawn → the daemon's event loop went quiet again (work queued
//              behind the exit, e.g. headless-mirror parsing, counts here)
//   frames     coalesced output frames delivered to the subscriber
//   bytes      output bytes delivered (must equal the seq output size)
//   lagMax / lagP99   event-loop delay while the burst ran (perf_hooks)
//   cpuMs      daemon CPU (user+sys) from spawn to settled
//
// Flags:
//   --runs N        runs per mode (default 5)
//   --count N       seq upper bound (default 100000)
//   --dist DIR      bench the build in DIR instead of ./dist (A/B against main)
//   --read-mirror   read the screen once right after spawn, the way the
//                   workspace-trust watchdog does for every agent launch, so the
//                   headless mirror is live for the whole burst
//
// Build first (npx tsc -b), then from packages/execution:
//   node harness/pty-seq-bench.mjs
//   node harness/pty-seq-bench.mjs --read-mirror
// MUST run under node, never bun (node-pty onData never fires under bun).

import { monitorEventLoopDelay } from 'node:perf_hooks';
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : fallback;
};
const RUNS = opt('--runs', 5);
const COUNT = opt('--count', 100_000);
const READ_MIRROR = flag('--read-mirror');
// --dist <dir> benches another build (e.g. a saved copy of main's dist) for A/B.
const distArg = argv.indexOf('--dist');
const DIST = distArg >= 0 ? new URL(`file://${process.cwd()}/${argv[distArg + 1]}/index.js`) : new URL('../dist/index.js', import.meta.url);
const { PtyHostService } = await import(DIST.href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quietLogger = { error() {}, warn() {}, info() {}, debug() {} };
const cpuMs = (u) => (u.user + u.system) / 1000;

// Expected byte count: seq prints "n\n", the tty turns each \n into \r\n.
let expectedBytes = 0;
for (let n = 1; n <= COUNT; n += 1) expectedBytes += String(n).length + 2;

async function runOnce(index) {
  const host = new PtyHostService({ logger: quietLogger });
  const sessionId = `bench-${process.pid}-${index}`;
  const lag = monitorEventLoopDelay({ resolution: 1 });
  let frames = 0;
  let bytes = 0;
  let exitAt = 0;
  let resolveExit;
  const exited = new Promise((r) => (resolveExit = r));

  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  lag.enable();
  host.spawn({ sessionId, command: `seq 1 ${COUNT}`, cwd: process.cwd(), env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
  host.onFrames(sessionId, (frame) => {
    if (frame[0] === 0x7b /* { */ && frame.toString('utf8').startsWith('{"type":"exit"')) {
      exitAt = performance.now();
      resolveExit();
      return;
    }
    frames += 1;
    bytes += frame.length;
  });
  if (READ_MIRROR) void host.readScreen(sessionId);
  await exited;
  const exitMs = exitAt - t0;

  // Settled: the loop is quiet once a 25ms sleep costs < 2ms of CPU twice in a row.
  let quiet = 0;
  let prev = process.cpuUsage();
  const deadline = performance.now() + 60_000;
  while (quiet < 2 && performance.now() < deadline) {
    await sleep(25);
    const now = process.cpuUsage();
    quiet = cpuMs(now) - cpuMs(prev) < 2 ? quiet + 1 : 0;
    prev = now;
  }
  // Exclude the two quiet probe windows from the settled time.
  const settledMs = performance.now() - t0 - 50;
  lag.disable();
  const cpu = cpuMs(process.cpuUsage(cpu0));
  host.shutdownAll();
  return {
    exitMs,
    settledMs,
    frames,
    bytes,
    lagMax: lag.max / 1e6,
    lagP99: lag.percentile(99) / 1e6,
    cpuMs: cpu,
  };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const results = [];
await runOnce(-1); // warm-up: JIT, node-pty, xterm module init
for (let i = 0; i < RUNS; i += 1) {
  const r = await runOnce(i);
  if (r.bytes !== expectedBytes) {
    console.error(`run ${i}: delivered ${r.bytes} bytes, expected ${expectedBytes}`);
    process.exitCode = 1;
  }
  results.push(r);
  console.log(
    `run ${i}: exit ${r.exitMs.toFixed(0)}ms settled ${r.settledMs.toFixed(0)}ms frames ${r.frames} ` +
      `bytes ${r.bytes} lagMax ${r.lagMax.toFixed(1)}ms lagP99 ${r.lagP99.toFixed(1)}ms cpu ${r.cpuMs.toFixed(0)}ms`,
  );
}
const keys = ['exitMs', 'settledMs', 'frames', 'lagMax', 'lagP99', 'cpuMs'];
const summary = Object.fromEntries(keys.map((k) => [k, Number(median(results.map((r) => r[k])).toFixed(1))]));
console.log(
  `\nseq 1 ${COUNT}${READ_MIRROR ? ' (mirror read at spawn)' : ''} — median of ${RUNS}: ` + JSON.stringify(summary),
);
