#!/usr/bin/env node
/**
 * Terminal perf-parity rig — the measurement half of gate G3.
 *
 * WHY THIS EXISTS (T-D21, 09 §7): tm8 is web-only, so "terminal perf is fine"
 * is an assumption until someone measures it against old maestro's terminal on
 * the SAME machine. This rig is that measurement. It is target-agnostic
 * (`--target legacy|tm8`, see adapters.mjs) precisely so the same code produces
 * both numbers and nobody can compare a measurement to a recollection.
 *
 * MODES — the first three are strictly read-only:
 *
 *   attach   N attach cycles against a live session. Measures connect → open →
 *            handshake → hydration (scrollback replay) and replay throughput.
 *            This is the metric a user feels as "how fast does my terminal come
 *            back when I open the tab", and it is the one most at risk in a
 *            browser-only client.
 *
 *   observe  Attach once, watch for D seconds. Measures live-frame cadence:
 *            inter-arrival distribution, bytes/s, and COALESCING CONFORMANCE —
 *            the fraction of consecutive frames arriving closer together than
 *            the server's promised 16ms coalescing window. Sub-window gaps mean
 *            the coalescer is leaking frames, which is the exact regression that
 *            made old maestro's UI lag.
 *            NOTE: inter-arrival is a *cadence* metric, not a latency metric —
 *            gaps are dominated by how often the agent writes. It is comparable
 *            across targets only for the coalescing floor, which is what we read.
 *
 *   fanout   K concurrent subscribers on one session. Measures per-subscriber
 *            delivery skew — does the Nth viewer get bytes as fast as the 1st?
 *            (Multi-window/mobile viewing depends on this; it is also the
 *            cheapest way to catch an O(subscribers) copy in the fan-out.)
 *
 *   echo     ** CONTROLLED / INVASIVE — REFUSES TO RUN WITHOUT EXPLICIT OPT-IN **
 *            Keystroke → first-byte-back round-trip: the only true end-to-end
 *            latency number. It WRITES into the target PTY, so it must never be
 *            pointed at a working agent's session. Requires BOTH
 *            `--controlled-session <id>` and `TM8_PERF_ALLOW_WRITE=1`.
 *
 * USAGE
 *   node pty-latency.mjs --target legacy --mode attach  --cycles 12
 *   node pty-latency.mjs --target legacy --mode observe --seconds 60 --session <id>
 *   node pty-latency.mjs --target legacy --mode fanout  --subscribers 4 --seconds 45
 *   TM8_PERF_ALLOW_WRITE=1 node pty-latency.mjs --mode echo --controlled-session <id>
 *   node pty-latency.mjs --target tm8 --mode attach --base-url http://localhost:4610
 *
 * Every run writes a JSON artifact to ./baselines/ and prints a markdown
 * summary. Raw per-frame samples are kept in the artifact so any number in it
 * can be recomputed independently — Polaris audits the artifact, not the claim.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getAdapter } from './adapters.mjs';
import { openRecordedSocket, waitFor, sleep, assertWebSocketAvailable } from '../lib/ws.mjs';
import { summarize, histogram, roundDeep, round } from '../lib/stats.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_DIR = path.join(HERE, 'baselines');

// ---------------------------------------------------------------- CLI parsing

function parseArgs(argv) {
  const args = {
    target: 'legacy',
    mode: 'attach',
    cycles: 10,
    seconds: 30,
    subscribers: 4,
    session: null,
    controlledSession: null,
    baseUrl: null,
    out: null,
    label: null,
    json: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--target': args.target = next(); break;
      case '--mode': args.mode = next(); break;
      case '--cycles': args.cycles = Number(next()); break;
      case '--seconds': args.seconds = Number(next()); break;
      case '--subscribers': args.subscribers = Number(next()); break;
      case '--session': args.session = next(); break;
      case '--controlled-session': args.controlledSession = next(); break;
      case '--base-url': args.baseUrl = next(); break;
      case '--out': args.out = next(); break;
      case '--label': args.label = next(); break;
      case '--json': args.json = true; break;
      case '--help': case '-h': printHelp(); process.exit(0); break;
      default:
        console.error(`unknown flag: ${arg}\n`);
        printHelp();
        process.exit(2);
    }
  }
  return args;
}

function printHelp() {
  console.log(String(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'))
    .split('\n')
    .slice(1, 48)
    .map((l) => l.replace(/^ \* ?/, '').replace(/^\/\*\*?/, ''))
    .join('\n'));
}

// ------------------------------------------------------------ machine context

/**
 * A perf number without its machine is unfalsifiable. Every artifact carries
 * the host so a later tm8 run can be checked for "same machine" before anyone
 * calls it parity.
 */
function machineContext() {
  return {
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpuModel: os.cpus()?.[0]?.model ?? 'unknown',
    cpuCount: os.cpus()?.length ?? null,
    totalMemGB: round(os.totalmem() / 1024 ** 3, 1),
    loadAvg1m: round(os.loadavg()?.[0], 2),
    nodeVersion: process.version,
  };
}

// ------------------------------------------------------------------ the modes

/**
 * ATTACH — read-only. One full attach cycle, torn down immediately.
 *
 * Breakdown (all relative to socket open):
 *   connectMs    dial → open        (TCP + WS upgrade)
 *   handshakeMs  open → `attached`  (server resolved the replay window)
 *   hydrationMs  open → replay frame fully received (the terminal can now paint)
 *   replayBytes / replayThroughputMBps
 *
 * `hydrationMs` is the headline: it is what "reopen the terminal" costs.
 */
async function runAttachCycle(adapter, baseUrl, sessionId) {
  const t0 = performance.now();
  const sock = openRecordedSocket(adapter.ptyUrl(baseUrl, sessionId, 0), { label: 'attach' });
  let handshake = null;

  const cycle = { connectMs: null, handshakeMs: null, hydrationMs: null, replayBytes: 0 };
  try {
    await sock.opened;
    cycle.connectMs = performance.now() - t0;
    const rec = sock.recorder;

    // Wait for the `attached` control frame, then (iff it promised one) the
    // single binary replay frame. Both are bounded — a hung handshake is a
    // finding, not something to wait out.
    await waitFor(
      rec,
      (r) => r.frames.some((f) => f.kind === 'text' && adapter.parseControl(f.text).type === 'attached'),
      10_000,
      'attach handshake',
    );
    const attachedFrame = rec.frames.find(
      (f) => f.kind === 'text' && adapter.parseControl(f.text).type === 'attached',
    );
    handshake = adapter.parseControl(attachedFrame.text);
    cycle.handshakeMs = attachedFrame.tMs - rec.eventAt('open').tMs;

    if (handshake.hasReplay) {
      await waitFor(rec, (r) => r.binaryFrames.length >= 1, 15_000, 'scrollback replay frame');
      const replay = rec.binaryFrames[0];
      cycle.hydrationMs = replay.tMs - rec.eventAt('open').tMs;
      cycle.replayBytes = replay.bytes;
    } else {
      // Nothing retained to replay: hydration is complete at the handshake.
      cycle.hydrationMs = cycle.handshakeMs;
      cycle.replayBytes = 0;
    }

    cycle.replayThroughputMBps =
      cycle.replayBytes > 0 && cycle.hydrationMs > 0
        ? cycle.replayBytes / 1024 / 1024 / (cycle.hydrationMs / 1000)
        : null;
    cycle.gap = handshake.gap;
    cycle.replayKind = handshake.replayKind;
    cycle.totalMs = performance.now() - t0;
    return cycle;
  } finally {
    await sock.stop();
  }
}

async function modeAttach(adapter, baseUrl, sessionId, cycles) {
  const results = [];
  for (let i = 0; i < cycles; i++) {
    try {
      results.push(await runAttachCycle(adapter, baseUrl, sessionId));
    } catch (error) {
      results.push({ error: error.message });
    }
    // Breathe between cycles: back-to-back attaches measure the server's accept
    // queue, not the attach path a user actually experiences.
    await sleep(250);
  }

  const good = results.filter((r) => !r.error);
  return {
    mode: 'attach',
    sessionId,
    cycles,
    failures: results.length - good.length,
    connectMs: summarize(good.map((r) => r.connectMs)),
    handshakeMs: summarize(good.map((r) => r.handshakeMs)),
    hydrationMs: summarize(good.map((r) => r.hydrationMs)),
    replayBytes: summarize(good.map((r) => r.replayBytes)),
    replayThroughputMBps: summarize(good.map((r) => r.replayThroughputMBps).filter((v) => v !== null)),
    samples: results,
  };
}

/**
 * OBSERVE — read-only. Attach once, watch the live stream.
 *
 * The load-bearing number is `coalescing.belowWindowPct`: the share of
 * consecutive frames arriving closer together than the server's coalescing
 * window. The server promises to batch output into ~16ms frames; a healthy
 * stream therefore has almost NO sub-16ms gaps. A high percentage means frames
 * are escaping the coalescer — the precise failure that produced old maestro's
 * terminal lag before the 16ms fan-out fix (commit 07d504d lineage).
 */
async function modeObserve(adapter, baseUrl, sessionId, seconds) {
  const sock = openRecordedSocket(adapter.ptyUrl(baseUrl, sessionId, 0), { label: 'observe' });
  await sock.opened;
  const rec = sock.recorder;

  await waitFor(
    rec,
    (r) => r.frames.some((f) => f.kind === 'text' && adapter.parseControl(f.text).type === 'attached'),
    10_000,
    'attach handshake',
  );
  const attached = adapter.parseControl(
    rec.frames.find((f) => f.kind === 'text' && adapter.parseControl(f.text).type === 'attached').text,
  );

  // The replay frame is one huge historical blob; including it would poison
  // both the cadence and the throughput numbers. Everything below is measured
  // from the first LIVE frame onward.
  const liveFromIndex = attached.hasReplay ? 1 : 0;
  const observeStart = performance.now() - rec.origin;

  await sleep(seconds * 1000);
  const observeEnd = performance.now() - rec.origin;
  await sock.stop();

  const live = rec.binaryFrames.slice(liveFromIndex).filter((f) => f.tMs >= observeStart);
  const gaps = [];
  for (let i = 1; i < live.length; i++) gaps.push(live[i].tMs - live[i - 1].tMs);

  const windowMs = adapter.coalesceMs;
  const belowWindow = gaps.filter((g) => g < windowMs).length;
  const totalBytes = live.reduce((a, f) => a + f.bytes, 0);
  const elapsedS = (observeEnd - observeStart) / 1000;

  return {
    mode: 'observe',
    sessionId,
    seconds,
    liveFrames: live.length,
    liveBytes: totalBytes,
    bytesPerSecond: elapsedS > 0 ? totalBytes / elapsedS : null,
    framesPerSecond: elapsedS > 0 ? live.length / elapsedS : null,
    frameBytes: summarize(live.map((f) => f.bytes)),
    interArrivalMs: summarize(gaps),
    interArrivalHistogram: histogram(gaps, [1, 4, 8, 16, 33, 66, 150, 500, 2000]),
    coalescing: {
      windowMs,
      gapsBelowWindow: belowWindow,
      belowWindowPct: gaps.length ? (belowWindow / gaps.length) * 100 : null,
      note:
        'Frames arriving closer than windowMs escaped the server-side coalescer. ' +
        'Near-zero is healthy; a rising share is the terminal-lag regression signature.',
    },
    // Raw samples so every statistic above is independently recomputable.
    samples: live.map((f) => ({ tMs: round(f.tMs, 3), bytes: f.bytes })),
  };
}

/**
 * FANOUT — read-only. K subscribers on one session; how even is delivery?
 *
 * Frames are matched across subscribers BY INDEX after every socket is live,
 * and only if the byte sizes agree frame-for-frame. If they don't agree the run
 * reports `aligned: false` and emits NO skew number — a plausible-looking skew
 * computed from misaligned streams is worse than no number at all.
 */
async function modeFanout(adapter, baseUrl, sessionId, subscribers, seconds) {
  const socks = [];
  for (let i = 0; i < subscribers; i++) {
    const sock = openRecordedSocket(adapter.ptyUrl(baseUrl, sessionId, 0), { label: `sub${i}` });
    await sock.opened;
    await waitFor(
      sock.recorder,
      (r) => r.frames.some((f) => f.kind === 'text' && adapter.parseControl(f.text).type === 'attached'),
      10_000,
      `subscriber ${i} handshake`,
    );
    socks.push(sock);
  }

  // Everyone is attached; from here the same live flushes reach all sockets.
  const alignAbs = performance.now();
  await sleep(seconds * 1000);

  // Absolute (process-clock) arrival times, so recorders with different origins
  // are directly comparable.
  const streams = socks.map((s) =>
    s.recorder.binaryFrames
      .map((f) => ({ abs: s.recorder.origin + f.tMs, bytes: f.bytes }))
      .filter((f) => f.abs >= alignAbs),
  );
  await Promise.all(socks.map((s) => s.stop()));

  const minLen = Math.min(...streams.map((s) => s.length));
  let aligned = minLen > 0;
  for (let i = 0; i < minLen && aligned; i++) {
    const sizes = new Set(streams.map((s) => s[i].bytes));
    if (sizes.size !== 1) aligned = false;
  }

  const skews = [];
  if (aligned) {
    for (let i = 0; i < minLen; i++) {
      const times = streams.map((s) => s[i].abs);
      skews.push(Math.max(...times) - Math.min(...times));
    }
  }

  return {
    mode: 'fanout',
    sessionId,
    subscribers,
    seconds,
    matchedFrames: minLen,
    aligned,
    perSubscriberFrames: streams.map((s) => s.length),
    perSubscriberBytes: streams.map((s) => s.reduce((a, f) => a + f.bytes, 0)),
    skewMs: aligned ? summarize(skews) : null,
    note: aligned
      ? 'skewMs = spread between first and last subscriber receiving the same flush.'
      : 'Streams did not align frame-for-frame; no skew reported (see the code comment — a ' +
        'misaligned skew number would be fiction). Re-run on a quieter session.',
  };
}

/**
 * ECHO — ** WRITES INTO THE TARGET PTY **. Controlled sessions only.
 *
 * The honest end-to-end number: keystroke bytes out → first output bytes back.
 * Includes PTY write, the child's echo, the 16ms coalescer, fan-out and the
 * socket — everything except browser paint. Old maestro's desktop terminal and
 * tm8's browser terminal are compared on exactly this.
 *
 * It is gated behind two independent opt-ins because pointing it at a working
 * agent injects keystrokes into that agent's prompt. It sends a bare CR
 * (`\r`) — the most inert thing a shell/TUI echoes — and never a command.
 */
export async function modeEcho(adapter, baseUrl, sessionId, cycles) {
  if (process.env.TM8_PERF_ALLOW_WRITE !== '1') {
    throw new Error(
      'echo mode WRITES into the target PTY and is refused by default.\n' +
        'Run it only against a session spawned for measurement, with:\n' +
        '  TM8_PERF_ALLOW_WRITE=1 node pty-latency.mjs --mode echo --controlled-session <id>\n' +
        'See PROCEDURE.md §"Controlled baseline run".',
    );
  }

  const sock = openRecordedSocket(adapter.ptyUrl(baseUrl, sessionId, 0), { label: 'echo' });
  await sock.opened;
  const rec = sock.recorder;
  await waitFor(
    rec,
    (r) => r.frames.some((f) => f.kind === 'text' && adapter.parseControl(f.text).type === 'attached'),
    10_000,
    'attach handshake',
  );
  // Let the replay land and the stream go quiet, so the next frame we see is
  // unambiguously a response to our keystroke and not tail-end scrollback.
  await sleep(1500);

  const samples = [];
  for (let i = 0; i < cycles; i++) {
    const before = rec.binaryFrames.length;
    const sentAt = performance.now() - rec.origin;
    sock.send(adapter.encodeInput('\r'));
    try {
      await waitFor(rec, (r) => r.binaryFrames.length > before, 3000, 'echo response frame');
      samples.push({ roundTripMs: rec.binaryFrames[before].tMs - sentAt, bytes: rec.binaryFrames[before].bytes });
    } catch {
      samples.push({ roundTripMs: null, timedOut: true });
    }
    await sleep(400); // stay well clear of the coalescing window between samples
  }
  await sock.stop();

  const good = samples.map((s) => s.roundTripMs).filter((v) => v !== null);
  return {
    mode: 'echo',
    sessionId,
    cycles,
    timeouts: samples.length - good.length,
    roundTripMs: summarize(good),
    samples,
    note:
      'keystroke(\\r) → first PTY output frame. Includes pty write + child echo + ' +
      '16ms coalescer + fan-out + socket; excludes client paint.',
  };
}

// -------------------------------------------------------------------- reports

function markdownReport(artifact) {
  const l = [];
  const r = artifact.result;
  l.push(`# PTY perf — ${artifact.target} / ${r.mode}`);
  l.push('');
  l.push(`- when: ${artifact.startedAt}`);
  l.push(`- base URL: ${artifact.baseUrl}`);
  l.push(`- session: ${r.sessionId ?? 'n/a'}`);
  l.push(`- host: ${artifact.machine.hostname} · ${artifact.machine.cpuModel} · ${artifact.machine.arch} · load1m ${artifact.machine.loadAvg1m}`);
  l.push('');

  const table = (title, s, unit = 'ms') => {
    if (!s || s.n === 0) return;
    l.push(`**${title}** (n=${s.n})`);
    l.push('');
    l.push('| min | p50 | p90 | p95 | max | mean |');
    l.push('|---|---|---|---|---|---|');
    l.push(`| ${round(s.min)}${unit} | ${round(s.p50)}${unit} | ${round(s.p90)}${unit} | ${round(s.p95)}${unit} | ${round(s.max)}${unit} | ${round(s.mean)}${unit} |`);
    l.push('');
  };

  if (r.mode === 'attach') {
    table('connect (dial → open)', r.connectMs);
    table('handshake (open → attached)', r.handshakeMs);
    table('hydration (open → scrollback painted)', r.hydrationMs);
    table('replay size', r.replayBytes, ' B');
    table('replay throughput', r.replayThroughputMBps, ' MB/s');
    if (r.failures) l.push(`> ${r.failures} of ${r.cycles} cycles failed.`);
  } else if (r.mode === 'observe') {
    l.push(`- live frames: ${r.liveFrames} · live bytes: ${r.liveBytes} · ${round(r.bytesPerSecond)} B/s · ${round(r.framesPerSecond)} frames/s`);
    l.push('');
    table('inter-frame gap (cadence, not latency)', r.interArrivalMs);
    table('frame size', r.frameBytes, ' B');
    l.push(`**Coalescing conformance** — ${r.coalescing.gapsBelowWindow} gaps below the ${r.coalescing.windowMs}ms window = **${round(r.coalescing.belowWindowPct)}%** (near-zero is healthy).`);
    l.push('');
  } else if (r.mode === 'fanout') {
    l.push(`- subscribers: ${r.subscribers} · matched frames: ${r.matchedFrames} · aligned: ${r.aligned}`);
    l.push('');
    if (r.aligned) table('per-flush delivery skew across subscribers', r.skewMs);
    else l.push(`> ${r.note}`);
    l.push('');
  } else if (r.mode === 'echo') {
    table('keystroke → first output frame', r.roundTripMs);
    if (r.timeouts) l.push(`> ${r.timeouts} of ${r.cycles} samples timed out.`);
  }
  return l.join('\n');
}

// ----------------------------------------------------------------------- main

async function main() {
  assertWebSocketAvailable();
  const args = parseArgs(process.argv);
  const adapter = getAdapter(args.target);
  const baseUrl = args.baseUrl ?? adapter.defaults.baseUrl;

  let sessionId = args.mode === 'echo' ? args.controlledSession : args.session;
  if (args.mode === 'echo' && !sessionId) {
    throw new Error('echo mode requires --controlled-session <id> (never a working agent session).');
  }
  if (!sessionId) {
    const sessions = await adapter.listSessions(baseUrl);
    if (!sessions.length) throw new Error('no live sessions to attach to; pass --session <id>');
    sessionId = sessions[sessions.length - 1].id;
    console.error(`# no --session given; using the most recent live session: ${sessionId}`);
  }

  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  let result;
  switch (args.mode) {
    case 'attach': result = await modeAttach(adapter, baseUrl, sessionId, args.cycles); break;
    case 'observe': result = await modeObserve(adapter, baseUrl, sessionId, args.seconds); break;
    case 'fanout': result = await modeFanout(adapter, baseUrl, sessionId, args.subscribers, args.seconds); break;
    case 'echo': result = await modeEcho(adapter, baseUrl, sessionId, args.cycles); break;
    default: throw new Error(`unknown --mode '${args.mode}' (attach|observe|fanout|echo)`);
  }

  const artifact = roundDeep({
    rig: 'pty-latency',
    rigVersion: 1,
    target: adapter.name,
    baseUrl,
    label: args.label,
    startedAt,
    durationMs: performance.now() - t0,
    machine: machineContext(),
    result,
  }, 3);

  fs.mkdirSync(BASELINE_DIR, { recursive: true });
  const outPath =
    args.out ??
    path.join(BASELINE_DIR, `${adapter.name}-${args.mode}-${startedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));

  if (args.json) console.log(JSON.stringify(artifact, null, 2));
  else console.log(markdownReport(artifact));
  console.error(`\n# artifact: ${outPath}`);
}

// Run only when invoked as a script. `echo-dry-run.mjs` imports `modeEcho` from
// here so the dry run exercises THE measurement code that will produce the
// controlled baseline — a dry run against a copy of the logic proves nothing.
const INVOKED_DIRECTLY =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (INVOKED_DIRECTLY) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(`\nperf rig failed: ${error.message}`);
      process.exit(1);
    },
  );
}
