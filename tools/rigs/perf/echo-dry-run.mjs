#!/usr/bin/env node
/**
 * Keystroke-echo DRY RUN — prove the echo rig before it touches a real PTY.
 *
 * WHY THIS EXISTS
 * ---------------
 * `pty-latency.mjs --mode echo` is the only mode that WRITES into a live PTY,
 * so it gets exactly one shot at a scheduled, controlled old-maestro session.
 * If the rig has a bug, we find out by having burned that session — and worse,
 * the failure mode is quiet: a round-trip rig that accidentally measures the
 * scrollback replay frame, or that reports a plausible number when nothing was
 * echoed at all, produces a baseline that is wrong rather than absent. A wrong
 * baseline is far more expensive than no baseline: G3 parity is judged against
 * it, so a fabricated number silently moves the bar.
 *
 * This script removes that risk. It stands up a mock PTY endpoint that speaks
 * old maestro's wire protocol with a KNOWN, injected echo delay, then runs the
 * REAL `modeEcho` (imported from `pty-latency.mjs`, not reimplemented) against
 * it and checks the measurement against ground truth. If the rig says 25ms when
 * the fixture delayed 25ms, discriminates a fast PTY from a slow one, and
 * reports timeouts instead of numbers when nothing echoes, then the measurement
 * machinery is sound and the only unknown left on baseline day is the target.
 *
 * MODES
 *   self       (default) Offline self-test against the mock. Touches no server.
 *   preflight  READ-ONLY checks against the live target + the designated
 *              controlled session. Sends nothing on the socket; verifies the
 *              session exists, is live, is not a working agent, and is QUIET
 *              enough that "first frame after the keystroke" is attributable.
 *              Prints the exact baseline command only if every check passes.
 *
 * USAGE
 *   node echo-dry-run.mjs
 *   node echo-dry-run.mjs --preflight --session <id> [--base-url http://localhost:4570]
 *   node echo-dry-run.mjs --preflight --session <id> --quiet-seconds 20
 *   node echo-dry-run.mjs --preflight --session <id> --confirm-controlled
 *
 * Exit code is non-zero if any check fails. See PROCEDURE.md for the full
 * controlled-baseline procedure this script gates.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startWebSocketServer, acceptKey } from '../lib/ws-server.mjs';
import { openRecordedSocket, sleep, waitFor, assertWebSocketAvailable } from '../lib/ws.mjs';
import { round } from '../lib/stats.mjs';
import { getAdapter } from './adapters.mjs';
import { modeEcho } from './pty-latency.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'dry-runs');

/** The echo payload the mock sends back — a shell's response to a bare CR. */
const ECHO_PAYLOAD = Buffer.from('\r\n$ ', 'utf8');

// ------------------------------------------------------------------ CLI

function parseArgs(argv) {
  const args = {
    mode: 'self',
    session: null,
    baseUrl: null,
    quietSeconds: 15,
    cycles: 6,
    confirmControlled: false,
    json: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case '--preflight': args.mode = 'preflight'; break;
      case '--self': args.mode = 'self'; break;
      case '--confirm-controlled': args.confirmControlled = true; break;
      case '--session': args.session = next(); break;
      case '--base-url': args.baseUrl = next(); break;
      case '--quiet-seconds': args.quietSeconds = Number(next()); break;
      case '--cycles': args.cycles = Number(next()); break;
      case '--json': args.json = true; break;
      case '--help': case '-h':
        console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
          .split('\n').slice(1, 43).map((l) => l.replace(/^ \* ?/, '').replace(/^\/\*\*?/, '')).join('\n'));
        process.exit(0);
        break;
      default:
        console.error(`unknown flag: ${argv[i]}`);
        process.exit(2);
    }
  }
  return args;
}

// ----------------------------------------------------------- check recorder

const checks = [];

function check(name, fn, { why } = {}) {
  try {
    const detail = fn();
    checks.push({ name, status: 'pass', why, detail: detail ?? null });
  } catch (error) {
    checks.push({ name, status: 'fail', why, error: error.message });
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// ------------------------------------------------------------- the fixture

/**
 * A mock of old maestro's `/pty` endpoint (protocol per adapters.mjs, verified
 * against PtyWebSocketServer.ts @ 07d504d):
 *
 *   s→c text {"type":"size",...}
 *   s→c text {"type":"attached",...}
 *   s→c bin  scrollback replay (once, iff hasReplay)
 *   c→s bin  keystroke  →  s→c bin  echo, after `echoDelayMs`
 *
 * `echoDelayMs` is the ground truth the measurement is checked against;
 * `silent: true` models the failure we most need the rig to catch — a PTY that
 * accepts input and never echoes.
 */
async function startMockPty({ echoDelayMs = 25, replayBytes = 32 * 1024, hasReplay = true, silent = false } = {}) {
  const server = await startWebSocketServer((sock) => {
    sock.sendText(JSON.stringify({ type: 'size', cols: 120, rows: 40 }));
    sock.sendText(JSON.stringify({
      type: 'attached', base: 0, gap: 0, next: replayBytes,
      hasReplay, replayKind: 'full', epoch: 'dry-run',
    }));
    if (hasReplay) sock.sendBinary(Buffer.alloc(replayBytes, 0x2e)); // '.' — inert scrollback

    sock.on('message', (payload, isBinary) => {
      if (!isBinary || silent) return;
      setTimeout(() => sock.sendBinary(ECHO_PAYLOAD), echoDelayMs);
    });
  });
  return server;
}

/** Run the REAL modeEcho against a mock with a known delay. */
async function measureAgainstMock(opts, cycles) {
  const mock = await startMockPty(opts);
  try {
    return await modeEcho(getAdapter('legacy'), mock.url, 'dry-run-session', cycles);
  } finally {
    await mock.close();
  }
}

// ------------------------------------------------------------- self-test

async function runSelfTest(cycles) {
  // 0. THE FIXTURE ITSELF — check the mock server's handshake against RFC 6455's
  //    worked example. A fixture nobody validated is just another unknown, and
  //    this exact constant was wrong once already (a one-character GUID typo
  //    that surfaced only as an opaque client-side `websocket error`).
  check('mock server computes the RFC 6455 §1.3 accept key correctly', () => {
    const got = acceptKey('dGhlIHNhbXBsZSBub25jZQ==');
    assert(got === 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=', `accept key ${got} != the RFC's worked example`);
    return { acceptKey: got };
  }, { why: 'A bad handshake fails as an unexplained socket error, not as a clear message.' });

  // 1. SAFETY INTERLOCK — checked FIRST, before the env var is ever set.
  //    If this ever stops throwing, the rig can be pointed at a working agent's
  //    session by accident, which is the one outcome we cannot take back.
  delete process.env.TM8_PERF_ALLOW_WRITE;
  let refused = false;
  try {
    await measureAgainstMock({ echoDelayMs: 1 }, 1);
  } catch (error) {
    refused = /refused by default/i.test(error.message);
  }
  check('safety interlock: echo mode refuses to run without TM8_PERF_ALLOW_WRITE=1', () => {
    assert(refused, 'modeEcho ran (or failed for the wrong reason) without the write opt-in');
  }, { why: 'echo writes into a live PTY; the interlock is what keeps it off a working agent.' });

  // Everything below is a deliberate, sanctioned write — into a local fixture.
  process.env.TM8_PERF_ALLOW_WRITE = '1';

  // 2. GROUND TRUTH — a known 25ms delay must come back as ~25ms.
  const SLOW_MS = 25;
  const slow = await measureAgainstMock({ echoDelayMs: SLOW_MS }, cycles);
  check(`measures ground truth: fixture delay ${SLOW_MS}ms → reported p50`, () => {
    assert(slow.roundTripMs.n === cycles, `expected ${cycles} samples, got ${slow.roundTripMs.n}`);
    assert(slow.timeouts === 0, `${slow.timeouts} sample(s) timed out against a responsive fixture`);
    assert(slow.roundTripMs.min >= SLOW_MS * 0.8,
      `p-min ${round(slow.roundTripMs.min)}ms is below the injected ${SLOW_MS}ms floor — the rig is measuring something that is not the round trip`);
    assert(slow.roundTripMs.p50 <= SLOW_MS + 60,
      `p50 ${round(slow.roundTripMs.p50)}ms is far above the injected ${SLOW_MS}ms — measurement overhead is drowning the signal`);
    return { p50: round(slow.roundTripMs.p50), min: round(slow.roundTripMs.min), max: round(slow.roundTripMs.max) };
  }, { why: 'A latency rig that does not track a known delay is measuring the wrong thing.' });

  // 3. REPLAY IS NOT AN ECHO — the subtle bug. modeEcho settles 1500ms after the
  //    handshake so the scrollback blob lands first; if that settle regressed,
  //    sample #1 would be the 32 KiB replay frame arriving at ~0ms.
  check('scrollback replay is not counted as an echo sample', () => {
    const wrongSized = slow.samples.filter((s) => s.bytes && s.bytes !== ECHO_PAYLOAD.length);
    assert(wrongSized.length === 0,
      `${wrongSized.length} sample(s) had the wrong byte size (${JSON.stringify(wrongSized)}) — a replay/scrollback frame was measured as a keystroke echo`);
    return { echoBytes: ECHO_PAYLOAD.length };
  }, { why: 'Measuring the replay blob yields a fast, plausible, entirely fictional number.' });

  // 4. DISCRIMINATION — a fast PTY must read as faster than a slow one. Proves
  //    the number is a measurement and not a constant floor of rig overhead.
  const fast = await measureAgainstMock({ echoDelayMs: 1 }, cycles);
  check('discriminates fast from slow (1ms fixture vs 25ms fixture)', () => {
    assert(fast.timeouts === 0, `${fast.timeouts} timeout(s) against the fast fixture`);
    const delta = slow.roundTripMs.p50 - fast.roundTripMs.p50;
    assert(delta > (SLOW_MS - 1) * 0.5,
      `p50 delta ${round(delta)}ms is too small for a ${SLOW_MS - 1}ms difference in ground truth`);
    return { fastP50: round(fast.roundTripMs.p50), slowP50: round(slow.roundTripMs.p50), deltaMs: round(delta) };
  }, { why: 'If both fixtures read the same, the rig is reporting its own overhead.' });

  // 5. LOUD FAILURE — a PTY that never echoes must produce timeouts and NO
  //    number. This is R17's silent-failure mode expressed in perf terms.
  const silent = await measureAgainstMock({ echoDelayMs: 0, silent: true }, 2);
  check('a silent PTY yields timeouts, never a fabricated number', () => {
    assert(silent.timeouts === 2, `expected 2 timeouts from a silent fixture, got ${silent.timeouts}`);
    assert(silent.roundTripMs.n === 0, `silent fixture still produced ${silent.roundTripMs.n} sample(s)`);
    assert(silent.roundTripMs.p50 === null, 'silent fixture produced a non-null p50');
    return { timeouts: silent.timeouts };
  }, { why: 'A broken prompt path must read as absent, not as fast (04 §6 / R17).' });

  // 6. HANDSHAKE PARSING — the legacy adapter really did understand `attached`.
  //    (A handshake it could not parse would have failed as a timeout above,
  //    but assert it explicitly so the failure names itself.)
  check('legacy adapter parses the `attached` handshake frame', () => {
    const parsed = getAdapter('legacy').parseControl(JSON.stringify({ type: 'attached', hasReplay: true, base: 0, gap: 0, next: 10 }));
    assert(parsed.type === 'attached' && parsed.hasReplay === true, `parseControl returned ${JSON.stringify(parsed)}`);
    return parsed;
  }, { why: 'Wrong handshake parsing = the rig never starts sampling.' });

  delete process.env.TM8_PERF_ALLOW_WRITE;
  return { slow, fast, silent };
}

// ------------------------------------------------------------- preflight

/**
 * READ-ONLY. Confirms the designated controlled session is real, live, and
 * quiet. Sends NOTHING on the socket — this runs before anyone has agreed to a
 * write, so it must be safe to run against the live :4570 server at any time.
 */
async function runPreflight(baseUrl, sessionId, quietSeconds, confirmControlled) {
  const adapter = getAdapter('legacy');

  let sessions = [];
  let listError = null;
  try {
    sessions = await adapter.listSessions(baseUrl);
  } catch (error) {
    listError = error;
  }
  check('target reachable: GET /api/sessions', () => {
    assert(!listError, `${listError?.message}`);
    return { liveSessions: sessions.length };
  }, { why: 'No target, no baseline.' });

  const match = sessions.find((s) => s.id === sessionId);
  check(`controlled session ${sessionId} exists and is live`, () => {
    assert(match, `session ${sessionId} is not in the live list (${sessions.map((s) => s.id).join(', ') || 'none live'})`);
    return match;
  }, { why: 'Writing to the wrong session id injects keystrokes into a working agent.' });

  // The status gate. This check was added because the first preflight run
  // PASSED against a session whose status was `working` — a live agent that
  // merely happened to be thinking (not printing) during the idle window. The
  // quiet watch alone cannot tell "spawned for measurement" from "busy agent
  // between outputs", and the consequence of confusing them is a stray CR in a
  // working agent's prompt. Quiet is necessary, not sufficient: an operator has
  // to assert that this session was spawned to be measured.
  check(`session is designated for measurement, not a working agent (status: ${match?.status ?? 'n/a'})`, () => {
    assert(match, 'no session to classify');
    if (match.status === 'working') {
      assert(confirmControlled,
        `session ${sessionId} reports status 'working' — an agent is mid-task in it. ` +
        'Spawn a session FOR the measurement (an idle shell) and preflight that one. ' +
        'If this session really was spawned for measurement and the status is stale, ' +
        're-run with --confirm-controlled to assert that explicitly.');
    }
    return { status: match.status, operatorConfirmed: confirmControlled };
  }, { why: 'A quiet window proves nothing about whether an agent owns this terminal.' });

  // Attach read-only and watch. Two things matter: attach works at all, and the
  // stream is quiet — because the echo metric attributes "the next binary frame"
  // to our keystroke. On a chatty session that attribution is simply false.
  let quiet = null;
  if (match) {
    const sock = openRecordedSocket(adapter.ptyUrl(baseUrl, sessionId, 0), { label: 'preflight' });
    await sock.opened;
    const rec = sock.recorder;
    await waitFor(
      rec,
      (r) => r.frames.some((f) => f.kind === 'text' && adapter.parseControl(f.text).type === 'attached'),
      10_000,
      'attach handshake',
    );
    await sleep(1500); // let the replay land, exactly as modeEcho does
    const beforeIdle = rec.binaryFrames.length;
    const idleStart = performance.now();
    await sleep(quietSeconds * 1000);
    const unsolicited = rec.binaryFrames.length - beforeIdle;
    await sock.stop();
    quiet = {
      quietSeconds,
      unsolicitedFrames: unsolicited,
      framesPerSecond: unsolicited / quietSeconds,
      observedMs: round(performance.now() - idleStart),
    };
  }

  check(`session is quiet enough to attribute an echo (${quietSeconds}s idle watch)`, () => {
    assert(quiet, 'idle watch did not run (attach failed)');
    assert(quiet.unsolicitedFrames === 0,
      `${quiet.unsolicitedFrames} unsolicited frame(s) arrived while idle — this session is producing output on its own, so "the first frame after the keystroke" is NOT attributable to the keystroke. Use a session sitting at an idle shell prompt.`);
    return quiet;
  }, { why: 'The echo metric assumes the next frame is a response. On a chatty session that assumption is false and the number is fiction.' });

  return { sessions: sessions.length, match: match ?? null, quiet };
}

// ---------------------------------------------------------------- reporting

function report(args, payload) {
  const failed = checks.filter((c) => c.status === 'fail');
  const lines = [];
  lines.push(`# keystroke-echo dry run — ${args.mode}`);
  lines.push('');
  for (const c of checks) {
    lines.push(`${c.status === 'pass' ? '✔' : '✘'} ${c.name}`);
    if (c.detail) lines.push(`    ${JSON.stringify(c.detail)}`);
    if (c.error) lines.push(`    ${c.error}`);
    if (c.status === 'fail' && c.why) lines.push(`    why it matters: ${c.why}`);
  }
  lines.push('');
  lines.push(failed.length
    ? `${failed.length} of ${checks.length} checks FAILED — do not schedule the controlled run.`
    : `all ${checks.length} checks passed.`);

  if (!failed.length && args.mode === 'self') {
    lines.push('');
    lines.push('Next: `node echo-dry-run.mjs --preflight --session <id>` against the');
    lines.push('controlled session, then follow PROCEDURE.md §"Controlled baseline run".');
  }
  if (!failed.length && args.mode === 'preflight') {
    lines.push('');
    lines.push('Ready. The controlled baseline command is:');
    lines.push('');
    lines.push(`  TM8_PERF_ALLOW_WRITE=1 node tools/rigs/perf/pty-latency.mjs \\`);
    lines.push(`    --target legacy --mode echo --controlled-session ${args.session} \\`);
    lines.push(`    --cycles 20 --label controlled-baseline`);
  }

  const artifact = {
    rig: 'echo-dry-run',
    rigVersion: 1,
    mode: args.mode,
    startedAt: new Date().toISOString(),
    baseUrl: args.mode === 'preflight' ? (args.baseUrl ?? getAdapter('legacy').defaults.baseUrl) : 'mock://local-fixture',
    sessionId: args.session,
    checks,
    passed: failed.length === 0,
    payload,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `echo-dry-${args.mode}-${artifact.startedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(out, JSON.stringify(artifact, null, 2));

  if (args.json) console.log(JSON.stringify(artifact, null, 2));
  else console.log(lines.join('\n'));
  console.error(`\n# artifact: ${out}`);
  return failed.length === 0;
}

// --------------------------------------------------------------------- main

async function main() {
  assertWebSocketAvailable();
  const args = parseArgs(process.argv);

  let payload;
  if (args.mode === 'preflight') {
    if (!args.session) throw new Error('--preflight requires --session <id> (the designated controlled session)');
    const baseUrl = args.baseUrl ?? getAdapter('legacy').defaults.baseUrl;
    payload = await runPreflight(baseUrl, args.session, args.quietSeconds, args.confirmControlled);
  } else {
    payload = await runSelfTest(args.cycles);
    // Summaries are already in the per-check details; keep the artifact small
    // but keep the raw samples, so any number above can be recomputed.
    payload = {
      slow: { roundTripMs: payload.slow.roundTripMs, samples: payload.slow.samples },
      fast: { roundTripMs: payload.fast.roundTripMs, samples: payload.fast.samples },
      silent: { timeouts: payload.silent.timeouts, samples: payload.silent.samples },
    };
  }

  return report(args, payload);
}

main().then(
  (ok) => process.exit(ok ? 0 : 1),
  (error) => {
    console.error(`\ndry run failed: ${error.message}`);
    process.exit(1);
  },
);
