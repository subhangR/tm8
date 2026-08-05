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
//
// WHY EVERY QUIET STRETCH BELOW IS `read -t N` AND NEVER `sleep N`: silence alone
// no longer declares a session idle. `sleep` is a real child process, and a live
// child is how the detector recognises WORK -- so a `sleep` here would (rightly)
// suppress the very signal these tests assert. `read -t` is a bash builtin: it
// produces the same silence with no process below the shell, which is the true
// shape of an agent waiting at its composer. Do not "simplify" it back.

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
    host.spawn({ sessionId, command: 'echo hello; read -t 5 x', cwd: '/tmp', env: {} });

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
    host.spawn({ sessionId: 'never-spoke', command: 'read -t 2 x', cwd: '/tmp', env: {} });

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
      command: `echo one; read -t ${gap} x; echo two; read -t 5 y`,
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
    host.spawn({ sessionId, command: 'echo hi; read -t 5 x', cwd: '/tmp', env: {} });

    await waitFor(() => seen.includes('idle'));
    // Still live, still attachable, still tracked.
    expect(host.hasSession(sessionId)).toBe(true);
  }, 20000);

  // ------------------------------------------------------------------
  // A TRAP THESE COMMANDS ARE WRITTEN AROUND, because it cost real debugging
  // time: `bash -c 'echo x; sleep 4'` does NOT leave a bash with a sleep child.
  // Bash exec-optimises the LAST command of a -c list, so the shell REPLACES
  // itself with `sleep` -- the pid the PTY tracks literally becomes the sleep,
  // and it has no descendants at all. Every command below therefore ends in a
  // trailing `; true`, which forces bash to stay alive as a real parent. That is
  // the shape the product actually has (a long-lived agent CLI that forks its
  // tools), and it is the only shape in which this gate means anything.
  //
  // THE WORK GATE. Silence is necessary evidence of a blocked agent, not
  // sufficient. Measured against real agents on this host: `claude` idle at its
  // prompt was silent 39.4s (a true "needs you"), and `claude` mid-turn waiting
  // on a long command was silent 33.0s and 41.3s on two runs (a false one).
  // Both are silence; only the process tree separates them.
  // ------------------------------------------------------------------

  it('does NOT report idle while a tool is still running below the agent', async () => {
    const log: { id: string; activity: PtyActivity }[] = [];
    host = makeHost(log);
    // Speak, then go quiet with a real child process alive -- the exact shape of
    // the measured false positive: an agent that has launched a long command and
    // is waiting on it. It is working. Nobody needs to be interrupted.
    host.spawn({
      sessionId: 'silent-but-working',
      command: `echo starting; sleep ${(IDLE_AFTER_MS * 8) / 1000}; true`,
      cwd: '/tmp',
      env: {},
    });

    // Well past the threshold that would have fired on silence alone.
    await wait(IDLE_AFTER_MS * 5);
    expect(log.filter((e) => e.activity === 'idle')).toHaveLength(0);
  }, 25000);

  it('reports idle once the work below finishes and the agent is genuinely waiting', async () => {
    const log: { id: string; activity: PtyActivity }[] = [];
    host = makeHost(log);
    // The full arc of a real turn: run a tool (silent, child alive -> working),
    // then wait for the human (silent, no child -> needs you). The SAME silence
    // means opposite things either side of the child exiting, which is the whole
    // point of the gate.
    host.spawn({
      sessionId: 'work-then-wait',
      command: `echo starting; sleep ${(IDLE_AFTER_MS * 4) / 1000}; read -t 5 x`,
      cwd: '/tmp',
      env: {},
    });

    await waitFor(() => log.some((e) => e.activity === 'idle'), 20000);
    // And it must not have fired DURING the work -- the report has to arrive
    // after the child is gone, not before.
    expect(log.filter((e) => e.activity === 'idle')).toHaveLength(1);
  }, 25000);

  it('sees work nested more than one level down -- a coordinator spawning an agent', async () => {
    const log: { id: string; activity: PtyActivity }[] = [];
    host = makeHost(log);
    // A tm8 session may itself be a coordinator: a claude-code session that
    // spawns a codex agent, which then runs a tool. The work is then a
    // GRANDCHILD of the PTY, and a one-level check would call this session idle
    // while its child agent is mid-task. Nested subshell reproduces that shape.
    host.spawn({
      sessionId: 'nested-work',
      command: `echo starting; bash -c 'bash -c "sleep ${(IDLE_AFTER_MS * 8) / 1000}; true"; true'; true`,
      cwd: '/tmp',
      env: {},
    });

    await wait(IDLE_AFTER_MS * 5);
    expect(log.filter((e) => e.activity === 'idle')).toHaveLength(0);
  }, 25000);
});
