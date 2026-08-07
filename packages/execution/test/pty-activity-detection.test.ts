// The block detector: what makes a session's `needs-you` state reachable.
//
// tm8 has had the whole "an agent is waiting for you" presentation since R8 --
// the verdict in session-presentation.ts, the pill, the NeedsYouBanner, the
// home-screen group -- gated behind one predicate: `live && status === 'idle'`.
// Nothing in the product ever wrote 'idle', so on real data the entire chain was
// dead. `onActivityChange` is the writer that was missing.
//
// REAL PTYs THROUGHOUT, and that is not incidental. This is a TIMING bug class,
// and the repo already paid for learning that fake timers cannot falsify it:
// PtyHostService.ts:138-141 records a prompt-submission fix that passed 40/40
// under a fake clock while submitting 0/4 against a real agent. A detector built
// on "the stream went quiet" has to be tested against a stream that actually
// goes quiet, so every case below drives a real shell and a real node-pty and
// waits on wall-clock time.
//
// `idleAfterMs` is turned down to keep the suite fast. The threshold under test
// is the state machine around it, not the production default (10s), which is a
// tuning decision to be measured against live agents -- see
// PtyHostOptions.idleAfterMs.

import { describe, expect, it, afterEach } from 'vitest';

import { PtyHostService } from '../src/pty/PtyHostService.js';
import type { PtyActivity } from '../src/pty/types.js';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, ms = 15000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await wait(10);
  }
}

const IDLE_AFTER_MS = 250;

describe('PtyHostService block detection -- the writer `needs-you` was waiting for', () => {
  let host: PtyHostService | undefined;

  afterEach(() => {
    host?.shutdownAll();
    host = undefined;
  });

  function makeHost(log: { id: string; activity: PtyActivity }[]): PtyHostService {
    return new PtyHostService({
      logger: quiet,
      idleAfterMs: IDLE_AFTER_MS,
      onActivityChange: (id, activity) => {
        log.push({ id, activity });
      },
    });
  }

  it('reports idle once a PTY that HAS spoken falls silent', async () => {
    const log: { id: string; activity: PtyActivity }[] = [];
    host = makeHost(log);
    const sessionId = 'quiet-after-output';
    // Speak, then hold the PTY open in silence -- the exact shape of an agent
    // that finished its turn and is waiting at its composer.
    host.spawn({ sessionId, command: 'echo hello; sleep 5', cwd: '/tmp', env: {} });

    await waitFor(() => log.some((e) => e.activity === 'idle'));
    expect(log.filter((e) => e.activity === 'idle')).toHaveLength(1);
    expect(log.every((e) => e.id === sessionId)).toBe(true);
  }, 20000);

  it('does NOT report idle for a PTY that has never produced a byte', async () => {
    const log: { id: string; activity: PtyActivity }[] = [];
    host = makeHost(log);
    // `shell -c` prints no prompt, so this process is silent from birth. Silence
    // that has never been broken is not a blocked agent, it is an unproven one --
    // reporting it would paint every session's boot window as "needs you".
    host.spawn({ sessionId: 'never-spoke', command: 'sleep 2', cwd: '/tmp', env: {} });

    await wait(IDLE_AFTER_MS * 4);
    expect(log.filter((e) => e.activity === 'idle')).toHaveLength(0);
  }, 20000);

  it('leaves idle as soon as bytes move again, and does not flap in between', async () => {
    const log: { id: string; activity: PtyActivity }[] = [];
    host = makeHost(log);
    const sessionId = 'speak-quiet-speak';
    const gap = (IDLE_AFTER_MS * 3) / 1000;
    host.spawn({
      sessionId,
      command: `echo one; sleep ${gap}; echo two; sleep 5`,
      cwd: '/tmp',
      env: {},
    });

    // idle (the gap) -> busy (the second echo) -> idle (the trailing sleep).
    await waitFor(() => log.filter((e) => e.activity === 'idle').length >= 2);
    const shape = log.map((e) => e.activity);

    // TRANSITIONS ONLY. A busy TUI emits hundreds of chunks a second and each
    // notification here ends in a database write, so a detector that fired per
    // chunk -- or re-fired 'idle' on every tick of silence -- would be unusable
    // for the reason that has nothing to do with correctness.
    for (let i = 1; i < shape.length; i += 1) {
      expect(shape[i]).not.toBe(shape[i - 1]);
    }
    // And the recovery is byte-driven, not timer-driven: the run must contain a
    // busy BETWEEN the two idles rather than two idles in a row.
    expect(shape).toContain('busy');
    expect(shape.indexOf('busy')).toBeGreaterThan(shape.indexOf('idle'));
  }, 25000);

  it('never reports idle after the PTY has exited', async () => {
    const log: { id: string; activity: PtyActivity }[] = [];
    let exited = false;
    host = new PtyHostService({
      logger: quiet,
      idleAfterMs: IDLE_AFTER_MS,
      onActivityChange: (id, activity) => {
        log.push({ id, activity });
      },
      onSessionStatus: () => {
        exited = true;
      },
    });
    // Speaks, then exits immediately -- so a pending idle timer is left behind
    // by the output that preceded the exit.
    host.spawn({ sessionId: 'exit-then-quiet', command: 'echo bye', cwd: '/tmp', env: {} });

    await waitFor(() => exited);
    const idleBefore = log.filter((e) => e.activity === 'idle').length;
    await wait(IDLE_AFTER_MS * 4);

    // 'exited' is terminal, and the transition RPC refuses exited -> idle with a
    // 23514. A timer that fired into the dead entry would turn an ordinary race
    // into a recurring error in the node's log.
    expect(log.filter((e) => e.activity === 'idle')).toHaveLength(idleBefore);
  }, 20000);

  it('survives a throwing sink -- a failed write must not take down the PTY host', async () => {
    const seen: PtyActivity[] = [];
    host = new PtyHostService({
      logger: quiet,
      idleAfterMs: IDLE_AFTER_MS,
      onActivityChange: (_id, activity) => {
        seen.push(activity);
        // The real sink ends in a database call. A node whose database blips
        // must keep serving terminals; the signal re-asserts itself on the next
        // transition, so there is nothing to recover.
        throw new Error('database unreachable');
      },
    });
    const sessionId = 'throwing-sink';
    host.spawn({ sessionId, command: 'echo hi; sleep 5', cwd: '/tmp', env: {} });

    await waitFor(() => seen.includes('idle'));
    // Still live, still attachable, still tracked.
    expect(host.hasSession(sessionId)).toBe(true);
  }, 20000);
});
